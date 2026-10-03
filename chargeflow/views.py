import math
from collections import defaultdict

from django.conf import settings
from django.db.models import F
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, render
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    ChargerState, ChargingStation, CongestionNotifySubscription, Highway,
    HighwayNode, HighwayNodeCharger, NodeStationMapping, StationCongestion, UserRoute, UserSetting,
)
from .serializers import ChargingStationSerializer, HighwayNodeSerializer, HighwaySerializer
from .services import toss_notify
from .services.congestion import (
    detour_extra_minutes, estimate_wait_minutes, predict, serialize_congestion, station_realtime,
    weekly_pattern,
)
from .services.ev_api import KST
from .user_identity import UserScopedAPIView


def config_view(request):
    return JsonResponse({
        'kakao_key': settings.KAKAO_JS_KEY,
    })


def _congestion_map(ra_ids):
    """RA id 목록 → {id: 혼잡도 dict} (한 번의 쿼리)"""
    now  = timezone.now()
    rows = {c.ra_node_id: c for c in StationCongestion.objects.filter(ra_node_id__in=ra_ids)}
    return {ra_id: serialize_congestion(rows.get(ra_id), now) for ra_id in ra_ids}


def _decision(ra_id, congestion, now=None):
    """휴게소에서 기다릴지 판단하는 데 필요한 값: 예상 대기 시간과 1·2시간 뒤 혼잡 예측"""
    level = congestion['level']
    wait  = estimate_wait_minutes(ra_id, now) if level == 'jammed' else (0 if congestion['available'] else None)
    return {
        'wait_minutes': wait,
        'prediction':   predict(ra_id, level, now),
    }


def _haversine_km(lat1, lng1, lat2, lng2):
    to_r  = math.pi / 180
    d_lat = (lat2 - lat1) * to_r
    d_lng = (lng2 - lng1) * to_r
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(lat1 * to_r) * math.cos(lat2 * to_r) * math.sin(d_lng / 2) ** 2
    )
    return 6371 * 2 * math.asin(math.sqrt(a))


# ──────────────────────────────────────────────
# GET /api/v1/highways/
# ──────────────────────────────────────────────
class HighwayListView(APIView):
    """서비스 대상 고속도로 목록"""

    def get(self, request):
        highways = Highway.objects.all().order_by('sort_order', 'id')
        return Response(HighwaySerializer(highways, many=True).data)


# ──────────────────────────────────────────────
# GET /api/v1/highways/<code>/nodes/
# ?direction=DOWN|UP  (필수)
# ?type=IC|RA|ALL     (기본: ALL)
# RA 노드에는 congestion(혼잡도 요약)이 함께 내려간다.
# ──────────────────────────────────────────────
class NodeListView(APIView):
    """특정 고속도로의 방향별 노드(IC/RA) 시퀀스"""

    def get(self, request, code):
        try:
            highway = Highway.objects.get(code=code)
        except Highway.DoesNotExist:
            return Response(
                {'detail': f'고속도로 코드 "{code}"를 찾을 수 없어요.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        direction = request.query_params.get('direction', '').upper()
        if direction not in ('UP', 'DOWN'):
            return Response(
                {'detail': 'direction 파라미터는 UP 또는 DOWN이어야 해요.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        node_type = request.query_params.get('type', 'ALL').upper()
        qs = HighwayNode.objects.filter(
            highway=highway, direction=direction, is_active=True,
        ).order_by('sequence')
        if node_type in ('IC', 'RA'):
            qs = qs.filter(node_type=node_type)

        nodes = list(qs)
        data  = HighwayNodeSerializer(nodes, many=True).data
        congestion = _congestion_map([n.id for n in nodes if n.node_type == 'RA'])
        for item in data:
            if item['node_type'] == 'RA':
                item['congestion'] = congestion[item['id']]

        return Response({
            'highway':   highway.name,
            'direction': direction,
            'nodes':     data,
        })


# ──────────────────────────────────────────────
# GET /api/v1/nodes/<pk>/bypass-stations/
# ?max_minutes=15  (기본값)
# ──────────────────────────────────────────────
class BypassStationView(APIView):
    """
    선택한 휴게소(RA) 기준 이전/다음 IC의 우회 충전소 추천.
    ChargeFlow의 핵심 API.
    """

    def get(self, request, pk):
        try:
            ra_node = (HighwayNode.objects
                       .select_related('highway', 'prev_ic', 'next_ic')
                       .get(pk=pk, is_active=True))
        except HighwayNode.DoesNotExist:
            return Response(
                {'detail': '해당 휴게소를 찾을 수 없어요.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        if ra_node.node_type != 'RA':
            return Response(
                {'detail': '휴게소(RA) id를 보내주세요.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            max_minutes = int(request.query_params.get('max_minutes', 15))
        except ValueError:
            max_minutes = 15
        max_minutes = max(1, min(max_minutes, 60))

        ic_nodes = [n for n in (ra_node.prev_ic, ra_node.next_ic) if n]
        source_ids = list(
            NodeStationMapping.objects
            .filter(ic_node__in=ic_nodes, drive_minutes__lte=max_minutes)
            .values_list('station__source_api_id', flat=True)
        )
        realtime = station_realtime([sid for sid in source_ids if sid])

        def build_ic_data(ic_node):
            if not ic_node:
                return None

            mappings = (
                NodeStationMapping.objects
                .filter(ic_node=ic_node, drive_minutes__lte=max_minutes)
                .exclude(station__name__contains='휴게소')
                .select_related('station')
                .order_by('-is_recommended', 'drive_minutes', 'distance_km')
            )

            stations = []
            for m in mappings:
                s = m.station
                stations.append({
                    'id':             s.id,
                    'name':           s.name,
                    'address':        s.address,
                    'place_type':     s.place_type,
                    'latitude':       str(s.latitude),
                    'longitude':      str(s.longitude),
                    'power_kw':       s.power_kw,
                    'connector_type': s.connector_type,
                    'charger_count':  s.charger_count,
                    'operator':       s.operator,
                    'open_hours':     s.open_hours,
                    'distance_km':    m.distance_km,
                    'drive_minutes':  m.drive_minutes,
                    'route_memo':     m.route_memo,
                    'is_recommended': m.is_recommended,
                    'is_estimated':   m.is_estimated,
                    'kakao_place_id': s.kakao_place_id or '',
                    'connectors':     [c for c in s.connectors.split(',') if c],
                    'realtime':       realtime.get(s.source_api_id or ''),
                    'detour_extra_minutes': detour_extra_minutes(m.drive_minutes),
                })

            return {
                'id':                     ic_node.id,
                'name':                   ic_node.name,
                'latitude':               str(ic_node.latitude),
                'longitude':              str(ic_node.longitude),
                'distance_from_start_km': ic_node.distance_from_start_km,
                'stations':               stations,
            }

        congestion = _congestion_map([ra_node.id])[ra_node.id]
        return Response({
            'target_rest_area': {
                'id':           ra_node.id,
                'name':         ra_node.name,
                'highway_code': ra_node.highway.code,
                'highway_name': ra_node.highway.name,
                'direction':    ra_node.direction,
                'latitude':  str(ra_node.latitude),
                'longitude': str(ra_node.longitude),
            },
            'congestion':  congestion,
            'decision':    _decision(ra_node.id, congestion),
            'previous_ic': build_ic_data(ra_node.prev_ic),
            'next_ic':     build_ic_data(ra_node.next_ic),
        })


# ──────────────────────────────────────────────
# GET /api/v1/stations/<pk>/
# ──────────────────────────────────────────────
class StationDetailView(APIView):
    """충전소 단일 상세 조회"""

    def get(self, request, pk):
        station = get_object_or_404(ChargingStation, pk=pk)
        return Response(ChargingStationSerializer(station).data)


# ──────────────────────────────────────────────
# GET /api/v1/nodes/<pk>/congestion/
# ──────────────────────────────────────────────
class NodeCongestionView(APIView):
    """휴게소 충전기 혼잡도 (폴러가 집계한 값)"""

    def get(self, request, pk):
        ra_node = get_object_or_404(HighwayNode, pk=pk, node_type='RA', is_active=True)
        data = _congestion_map([ra_node.id])[ra_node.id]
        if data['level'] == 'unknown':
            detail = '지금은 충전기 정보를 받아오지 못했어요.'
        else:
            detail = f'바로 충전 {data["available"]}대 · 충전 중 {data["charging"]}대'
            if data['offline']:
                detail += f' · 이용 불가 {data["offline"]}대'
        return Response({
            'node_id':   ra_node.id,
            'rest_area': ra_node.name,
            'detail':    detail,
            **data,
            **_decision(ra_node.id, data),
        })


# ──────────────────────────────────────────────
# GET /api/v1/nodes/<pk>/pattern/?weekday=0~6 (기본: 오늘)
# ──────────────────────────────────────────────
class NodePatternView(APIView):
    """요일·시간대별 혼잡 확률과 1·2시간 뒤 예측"""

    def get(self, request, pk):
        ra_node = get_object_or_404(HighwayNode, pk=pk, node_type='RA', is_active=True)
        now = timezone.now()
        try:
            weekday = int(request.query_params.get('weekday', now.astimezone(KST).weekday())) % 7
        except ValueError:
            weekday = now.astimezone(KST).weekday()
        congestion = _congestion_map([ra_node.id])[ra_node.id]
        hours = weekly_pattern(ra_node.id, weekday)
        return Response({
            'node_id':     ra_node.id,
            'weekday':     weekday,
            'hours':       hours,
            'has_pattern': sum(1 for h in hours if h['waiting_rate'] is not None) >= 6,
            'prediction':  predict(ra_node.id, congestion['level'], now),
        })


# ──────────────────────────────────────────────
# GET /api/v1/nodes/<pk>/nearby-stations/
# ──────────────────────────────────────────────
class RANearbyStationsView(APIView):
    """휴게소(RA)에 매핑된 환경부 충전소별 현황"""

    def get(self, request, pk):
        ra_node  = get_object_or_404(HighwayNode, pk=pk, node_type='RA', is_active=True)
        chargers = list(HighwayNodeCharger.objects.filter(ra_node=ra_node))

        stats = defaultdict(list)
        for stat_id, stat in (ChargerState.objects
                              .filter(stat_id__in=[c.stat_id for c in chargers])
                              .values_list('stat_id', 'stat')):
            stats[stat_id].append(stat)

        result = []
        for ch in chargers:
            s = stats.get(ch.stat_id, [])
            result.append({
                'stat_id':     ch.stat_id,
                'name':        ch.stat_name,
                'latitude':    str(ra_node.latitude),
                'longitude':   str(ra_node.longitude),
                'available':   sum(1 for x in s if x == '2'),
                'charging':    sum(1 for x in s if x == '3'),
                'total':       len(s),
                'charger_cnt': ch.charger_cnt,
            })

        return Response({
            'node_id':   ra_node.id,
            'rest_area': ra_node.name,
            'stations':  result,
        })


# ──────────────────────────────────────────────
# GET /api/v1/nodes/nearest-ra/?lat=&lng=&limit=5
# ──────────────────────────────────────────────
def _bearing(lat1, lng1, lat2, lng2):
    """두 지점의 진행 방위각(0=북, 90=동)"""
    r = math.pi / 180
    y = math.sin((lng2 - lng1) * r) * math.cos(lat2 * r)
    x = (math.cos(lat1 * r) * math.sin(lat2 * r)
         - math.sin(lat1 * r) * math.cos(lat2 * r) * math.cos((lng2 - lng1) * r))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _angle_diff(a, b):
    return abs((a - b + 180) % 360 - 180)


def _travel_bearings():
    """RA id → 그 휴게소를 지날 때의 진행 방위 (같은 노선·방향의 앞뒤 노드로 계산)"""
    nodes = defaultdict(list)
    for n in HighwayNode.objects.filter(is_active=True).only(
        'id', 'highway_id', 'direction', 'sequence', 'node_type', 'latitude', 'longitude',
    ):
        nodes[(n.highway_id, n.direction)].append(n)
    result = {}
    for seq in nodes.values():
        seq.sort(key=lambda n: n.sequence)
        for i, n in enumerate(seq):
            if n.node_type != 'RA':
                continue
            prev_n = seq[max(0, i - 1)]
            next_n = seq[min(len(seq) - 1, i + 1)]
            if prev_n is next_n:
                continue
            result[n.id] = _bearing(float(prev_n.latitude), float(prev_n.longitude),
                                    float(next_n.latitude), float(next_n.longitude))
    return result


HEADING_TOLERANCE = 60   # 진행 방향과 휴게소 방향 차이 허용(도)
AHEAD_TOLERANCE   = 80   # 내 위치에서 휴게소가 앞쪽인지 판단(도)
AHEAD_MAX_KM      = 120


class NearestRAView(APIView):
    """현재 위치 기준 휴게소 N개 — 홈 화면 원터치 진입용

    heading(진행 방위, 0~360)을 주면 '앞으로 지날 같은 방향 휴게소'만 거리순으로 준다.
    맞는 곳이 없으면 방향과 무관한 가까운 순서로 돌려주고 direction_matched=false."""

    def get(self, request):
        try:
            lat = float(request.query_params.get('lat'))
            lng = float(request.query_params.get('lng'))
        except (TypeError, ValueError):
            return Response(
                {'detail': 'lat, lng 파라미터가 필요해요.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            limit = int(request.query_params.get('limit', 5))
        except ValueError:
            limit = 5
        limit = max(1, min(limit, 20))

        try:
            heading = float(request.query_params['heading']) % 360
        except (KeyError, ValueError):
            heading = None

        ranked = sorted(
            (
                (_haversine_km(lat, lng, float(n.latitude), float(n.longitude)), n)
                for n in HighwayNode.objects.filter(node_type='RA', is_active=True).select_related('highway')
            ),
            key=lambda pair: pair[0],
        )

        matched = False
        if heading is not None:
            travel = _travel_bearings()
            ahead = [
                (dist, n) for dist, n in ranked
                if dist <= AHEAD_MAX_KM
                and n.id in travel
                and _angle_diff(travel[n.id], heading) <= HEADING_TOLERANCE
                and (dist < 1 or _angle_diff(
                    _bearing(lat, lng, float(n.latitude), float(n.longitude)), heading) <= AHEAD_TOLERANCE)
            ]
            if ahead:
                ranked, matched = ahead, True
        ranked = ranked[:limit]

        congestion = _congestion_map([n.id for _, n in ranked])
        return Response({
            'direction_matched': matched,
            'stations': [{
                'id':           n.id,
                'name':         n.name,
                'highway_code': n.highway.code,
                'highway_name': n.highway.name,
                'direction':    n.direction,
                'latitude':     str(n.latitude),
                'longitude':    str(n.longitude),
                'distance_km':  round(dist, 2),
                'congestion':   congestion[n.id],
            } for dist, n in ranked],
        })


# ──────────────────────────────────────────────
# GET /api/v1/highways/<code>/trip/?direction=&from=<node_id>&to=<node_id>
# 구간 안 휴게소를 순서대로, 도착 예상 시각 기준 혼잡 예측과 함께
# ──────────────────────────────────────────────
TRIP_SPEED_KMH = 90


class TripView(APIView):
    def get(self, request, code):
        highway   = get_object_or_404(Highway, code=code)
        direction = request.query_params.get('direction', '').upper()
        if direction not in ('UP', 'DOWN'):
            return Response({'detail': 'direction 파라미터는 UP 또는 DOWN이어야 해요.'},
                            status=status.HTTP_400_BAD_REQUEST)
        nodes = list(HighwayNode.objects.filter(highway=highway, direction=direction, is_active=True)
                     .order_by('sequence'))
        by_id = {n.id: n for n in nodes}
        try:
            start = by_id[int(request.query_params.get('from'))]
            end   = by_id[int(request.query_params.get('to'))]
        except (TypeError, ValueError, KeyError):
            return Response({'detail': '출발·도착 지점을 이 노선·방향에서 골라 주세요.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if end.sequence <= start.sequence:
            return Response({'detail': '도착 지점은 출발 지점보다 앞쪽이어야 해요.'},
                            status=status.HTTP_400_BAD_REQUEST)

        rest_areas = [n for n in nodes if n.node_type == 'RA' and start.sequence <= n.sequence <= end.sequence]
        congestion = _congestion_map([n.id for n in rest_areas])
        now = timezone.now()
        stops = []
        for n in rest_areas:
            km  = max(0.0, n.distance_from_start_km - start.distance_from_start_km)
            eta = km / TRIP_SPEED_KMH
            forecast = (predict(n.id, congestion[n.id]['level'], now, horizons=(eta,))[0]
                        if eta >= 0.25 else None)
            stops.append({
                'id':            n.id,
                'name':          n.name,
                'km_from_start': round(km, 1),
                'eta_minutes':   round(eta * 60),
                'congestion':    congestion[n.id],
                'forecast':      forecast,
            })
        return Response({
            'highway':   highway.name,
            'direction': direction,
            'from':      {'id': start.id, 'name': start.name},
            'to':        {'id': end.id, 'name': end.name},
            'total_km':  round(end.distance_from_start_km - start.distance_from_start_km, 1),
            'stops':     stops,
        })


# ──────────────────────────────────────────────
# 사용자 최근 방문 / 즐겨찾기 (userKey 기준)
# ──────────────────────────────────────────────
def _serialize_user_routes(routes):
    congestion = _congestion_map([ur.ra_node_id for ur in routes])
    return [{
        'ra_node_id':   ur.ra_node.id,
        'name':         ur.ra_node.name,
        'highway_code': ur.ra_node.highway.code,
        'highway_name': ur.ra_node.highway.name,
        'direction':    ur.ra_node.direction,
        'is_favorite':  ur.is_favorite,
        'notify_enabled': ur.notify_enabled,
        'visit_count':  ur.visit_count,
        'last_used_at': ur.last_used_at.isoformat(),
        'congestion':   congestion[ur.ra_node_id],
    } for ur in routes]


class UserRouteListView(UserScopedAPIView):
    """GET  /api/v1/me/routes/  — 최근 방문 + 즐겨찾기 목록
       POST /api/v1/me/routes/  — 방문 기록(upsert), body: {ra_node_id}"""

    def get(self, request):
        qs = (
            UserRoute.objects
            .filter(user_key=self.user_key)
            .select_related('ra_node__highway')
            .order_by('-last_used_at')
        )
        recent    = list(qs[:10])
        favorites = [ur for ur in qs if ur.is_favorite]
        return Response({
            'recent':    _serialize_user_routes(recent),
            'favorites': _serialize_user_routes(favorites),
        })

    def post(self, request):
        ra_node = get_object_or_404(HighwayNode, pk=request.data.get('ra_node_id'), node_type='RA')

        obj, created = UserRoute.objects.get_or_create(user_key=self.user_key, ra_node=ra_node)
        if not created:
            obj.visit_count = F('visit_count') + 1
            obj.save(update_fields=['visit_count', 'last_used_at'])
            obj.refresh_from_db()

        return Response(
            _serialize_user_routes([obj])[0],
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class UserRouteFavoriteView(UserScopedAPIView):
    """POST/DELETE /api/v1/me/routes/<ra_node_id>/favorite/ — 즐겨찾기 토글"""

    def post(self, request, ra_node_id):
        ra_node = get_object_or_404(HighwayNode, pk=ra_node_id, node_type='RA')
        obj, _ = UserRoute.objects.get_or_create(user_key=self.user_key, ra_node=ra_node)
        obj.is_favorite = True
        obj.save(update_fields=['is_favorite', 'last_used_at'])
        return Response(_serialize_user_routes([obj])[0])

    def delete(self, request, ra_node_id):
        UserRoute.objects.filter(
            user_key=self.user_key, ra_node_id=ra_node_id,
        ).update(is_favorite=False, notify_enabled=False)
        return Response(status=status.HTTP_204_NO_CONTENT)


class UserRouteNotifyView(UserScopedAPIView):
    """POST/DELETE /api/v1/me/routes/<ra_node_id>/notify/ — 즐겨찾기 상태 알림 켜기/끄기"""

    def post(self, request, ra_node_id):
        ra_node = get_object_or_404(HighwayNode, pk=ra_node_id, node_type='RA')
        obj, _ = UserRoute.objects.get_or_create(user_key=self.user_key, ra_node=ra_node)
        obj.is_favorite = True  # 알림은 즐겨찾기한 휴게소에만 보낸다
        obj.notify_enabled = True
        obj.save(update_fields=['is_favorite', 'notify_enabled', 'last_used_at'])
        data = _serialize_user_routes([obj])[0]
        data['deliverable'] = toss_notify.recipient_header(self.user_key) is not None
        return Response(data)

    def delete(self, request, ra_node_id):
        UserRoute.objects.filter(user_key=self.user_key, ra_node_id=ra_node_id).update(notify_enabled=False)
        return Response(status=status.HTTP_204_NO_CONTENT)


class UserSettingView(UserScopedAPIView):
    """GET/PUT /api/v1/me/settings/ — {connector: '' | combo | chademo | ac3 | nacs}"""

    def get(self, request):
        setting = UserSetting.objects.filter(user_key=self.user_key).first()
        return Response({'connector': setting.connector if setting else ''})

    def put(self, request):
        connector = request.data.get('connector', '')
        if connector not in dict(UserSetting.CONNECTOR_CHOICES):
            return Response({'detail': '지원하지 않는 커넥터예요.'}, status=status.HTTP_400_BAD_REQUEST)
        UserSetting.objects.update_or_create(user_key=self.user_key, defaults={'connector': connector})
        return Response({'connector': connector})


class UserRouteDeleteView(UserScopedAPIView):
    """DELETE /api/v1/me/routes/<ra_node_id>/ — 최근 목록에서 완전 삭제"""

    def delete(self, request, ra_node_id):
        UserRoute.objects.filter(user_key=self.user_key, ra_node_id=ra_node_id).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ──────────────────────────────────────────────
# 혼잡 해소 알림 구독 — 실제 발송은 poll_charger_status가 담당
# ──────────────────────────────────────────────
class CongestionNotifySubscribeView(UserScopedAPIView):
    """GET/POST/DELETE /api/v1/nodes/<pk>/notify-me/"""

    def get(self, request, pk):
        subscribed = CongestionNotifySubscription.objects.filter(
            user_key=self.user_key, ra_node_id=pk, is_active=True,
        ).exists()
        return Response({'subscribed': subscribed})

    def post(self, request, pk):
        ra_node = get_object_or_404(HighwayNode, pk=pk, node_type='RA', is_active=True)
        CongestionNotifySubscription.objects.update_or_create(
            user_key=self.user_key, ra_node=ra_node,
            defaults={'is_active': True, 'notified_at': None, 'subscribed_at': timezone.now()},
        )
        return Response({
            'subscribed': True,
            'rest_area':  ra_node.name,
            # 토스 앱 밖(웹 브라우저) 사용자는 메시지를 받을 수 없다
            'deliverable': toss_notify.recipient_header(self.user_key) is not None,
        })

    def delete(self, request, pk):
        CongestionNotifySubscription.objects.filter(
            user_key=self.user_key, ra_node_id=pk,
        ).update(is_active=False)
        return Response(status=status.HTTP_204_NO_CONTENT)


def index_view(request):
    """구버전 웹 화면 (앱인토스 번들 전환 전까지 유지)"""
    kakao_key = getattr(settings, 'KAKAO_JS_KEY', '') or getattr(settings, 'KAKAO_API_KEY', '')
    return render(request, 'index.html', {'kakao_key': kakao_key})
