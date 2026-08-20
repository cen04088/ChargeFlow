from django.shortcuts import render, get_object_or_404
from django.conf import settings
from django.db.models import F
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from django.conf import settings
from .models import (
    Highway, HighwayNode, ChargingStation, NodeStationMapping,
    UserRoute, CongestionNotifySubscription,
)
from django.http import JsonResponse
from .user_identity import UserScopedAPIView
from .serializers import (
    HighwaySerializer,
    HighwayNodeSerializer,
    ChargingStationSerializer,
)

def config_view(request):
    return JsonResponse({
        'kakao_key': settings.KAKAO_JS_KEY,
    })

# ──────────────────────────────────────────────
# GET /api/v1/highways/
# ──────────────────────────────────────────────
class HighwayListView(APIView):
    """서비스 대상 고속도로 목록"""

    def get(self, request):
        highways = Highway.objects.all().order_by('id')
        serializer = HighwaySerializer(highways, many=True)
        return Response(serializer.data)


# ──────────────────────────────────────────────
# GET /api/v1/highways/<code>/nodes/
# ?direction=DOWN|UP  (필수)
# ?type=IC|RA|ALL     (기본: ALL)
# ──────────────────────────────────────────────
class NodeListView(APIView):
    """특정 고속도로의 방향별 노드(IC/RA) 시퀀스"""

    def get(self, request, code):
        # 고속도로 존재 확인
        try:
            highway = Highway.objects.get(code=code)
        except Highway.DoesNotExist:
            return Response(
                {'detail': f'고속도로 코드 "{code}"를 찾을 수 없습니다.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        # direction 파라미터 검증
        direction = request.query_params.get('direction', '').upper()
        if direction not in ('UP', 'DOWN'):
            return Response(
                {'detail': 'direction 파라미터는 UP 또는 DOWN 이어야 합니다.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # node_type 파라미터
        node_type = request.query_params.get('type', 'ALL').upper()
        qs = HighwayNode.objects.filter(
            highway=highway,
            direction=direction,
            is_active=True,
        ).order_by('sequence')

        if node_type in ('IC', 'RA'):
            qs = qs.filter(node_type=node_type)

        serializer = HighwayNodeSerializer(qs, many=True)
        return Response({
            'highway': highway.name,
            'direction': direction,
            'nodes': serializer.data,
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
        # RA 노드 확인
        try:
            ra_node = HighwayNode.objects.get(pk=pk, is_active=True)
        except HighwayNode.DoesNotExist:
            return Response(
                {'detail': '해당 노드를 찾을 수 없습니다.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        if ra_node.node_type != 'RA':
            return Response(
                {'detail': '선택한 노드는 휴게소(RA)가 아닙니다. RA node_id를 전달해주세요.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # max_minutes 파라미터 (기본 15분)
        try:
            max_minutes = int(request.query_params.get('max_minutes', 15))
        except ValueError:
            max_minutes = 15

        # prev_ic / next_ic 필드에서 직접 가져옴
        prev_ic = ra_node.prev_ic
        next_ic = ra_node.next_ic

        def build_ic_data(ic_node):
            """IC 노드에 연결된 충전소 데이터 조합"""
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
                    'place_type':     s.place_type,
                    'latitude':       str(s.latitude),
                    'longitude':      str(s.longitude),
                    'power_kw':       s.power_kw,
                    'connector_type': s.connector_type,
                    'charger_count':  s.charger_count,
                    'open_hours':     s.open_hours,
                    'distance_km':    m.distance_km,
                    'drive_minutes':  m.drive_minutes,
                    'route_memo':     m.route_memo,
                    'is_recommended':  m.is_recommended,
                    'kakao_place_id':  s.kakao_place_id or '',
                })

            return {
                'id':                     ic_node.id,
                'name':                   ic_node.name,
                'latitude':               str(ic_node.latitude),
                'longitude':              str(ic_node.longitude),
                'distance_from_start_km': ic_node.distance_from_start_km,
                'stations':               stations,
            }

        return Response({
            'target_rest_area': {
                'id':        ra_node.id,
                'name':      ra_node.name,
                'direction': ra_node.direction,
            },
            'bypass_message': (
                f'{ra_node.name}이 혼잡할 경우, '
                f'IC를 나가면 확실하게 충전할 수 있어요!'
            ),
            'previous_ic': build_ic_data(prev_ic),
            'next_ic':     build_ic_data(next_ic),
        })


# ──────────────────────────────────────────────
# GET /api/v1/stations/<pk>/
# ──────────────────────────────────────────────
class StationDetailView(APIView):
    """충전소 단일 상세 조회 (카카오맵 마커 클릭 시)"""

    def get(self, request, pk):
        try:
            station = ChargingStation.objects.get(pk=pk)
        except ChargingStation.DoesNotExist:
            return Response(
                {'detail': '해당 충전소를 찾을 수 없습니다.'},
                status=status.HTTP_404_NOT_FOUND,
            )
        serializer = ChargingStationSerializer(station)
        return Response(serializer.data)


# ──────────────────────────────────────────────
# GET /api/v1/nodes/<pk>/congestion/
# ──────────────────────────────────────────────
class NodeCongestionView(APIView):
    """
    해당 RA(휴게소) 노드의 충전기 현황 반환.
    최근 폴링된 stat 값을 직접 집계해서 반환.
    """

    STAT_LABELS = {
        '1': '통신이상',
        '2': '충전가능',
        '3': '충전중',
        '4': '운영중지',
        '5': '점검중',
        '9': '상태미확인',
    }

    def get(self, request, pk):
        try:
            ra_node = HighwayNode.objects.get(pk=pk, node_type='RA', is_active=True)
        except HighwayNode.DoesNotExist:
            return Response(
                {'detail': '해당 노드를 찾을 수 없습니다.'},
                status=status.HTTP_404_NOT_FOUND,
            )

        from chargeflow.models import ChargerStatusLog
        from django.utils import timezone
        from datetime import timedelta

        # 최근 10분 내 각 충전기의 가장 최신 상태
        window = timezone.now() - timedelta(minutes=10)
        recent_logs = (
            ChargerStatusLog.objects
            .filter(ra_node=ra_node, checked_at__gte=window)
            .order_by('charger_id', '-checked_at')
        )

        # 충전기별 최신 상태만 집계
        seen = {}
        for log in recent_logs:
            if log.charger_id not in seen:
                seen[log.charger_id] = log.stat

        latest_checked_at = (
            recent_logs.order_by('-checked_at').values_list('checked_at', flat=True).first()
        )

        if not seen:
            return Response({
                'node_id':    pk,
                'rest_area':  ra_node.name,
                'level':      'unknown',
                'label':      '정보 없음',
                'color':      'gray',
                'detail':     '아직 수집된 충전기 정보가 없어요.',
                'stats':      {},
                'available':  None,
                'total':      None,
                'checked_at': None,
            })

        # stat별 집계
        stats = {}
        for stat in seen.values():
            label = self.STAT_LABELS.get(stat, '알 수 없음')
            stats[label] = stats.get(label, 0) + 1

        total     = len(seen)
        available = sum(1 for s in seen.values() if s == '2')
        charging  = sum(1 for s in seen.values() if s == '3')

        # 레벨 판단
        if total == 0:
            level, color = 'unknown', 'gray'
        elif available == 0 and charging == 0:
            level, color = 'jammed', 'red'
        elif available == 0:
            level, color = 'busy', 'orange'
        elif available / total >= 0.5:
            level, color = 'smooth', 'green'
        else:
            level, color = 'normal', 'blue'

        return Response({
            'node_id':    pk,
            'rest_area':  ra_node.name,
            'level':      level,
            'color':      color,
            'available':  available,
            'charging':   charging,
            'total':      total,
            'stats':      stats,
            'detail':     f'충전가능 {available}기 / 충전중 {charging}기 / 전체 {total}기',
            'checked_at': latest_checked_at.isoformat() if latest_checked_at else None,
        })





# GET /api/v1/nodes/<pk>/nearby-stations/
# ──────────────────────────────────────────────
class RANearbyStationsView(APIView):
    """
    휴게소(RA) 반경 100m 내 충전소 반환.
    HighwayNodeCharger의 statId 기반으로 매핑된 충전소만 반환.
    """

    def get(self, request, pk):
        import math
        try:
            ra_node = HighwayNode.objects.get(pk=pk, node_type='RA', is_active=True)
        except HighwayNode.DoesNotExist:
            return Response({'detail': '노드를 찾을 수 없습니다.'}, status=404)

        from chargeflow.models import HighwayNodeCharger, ChargerStatusLog
        from django.utils import timezone
        from datetime import timedelta

        chargers = HighwayNodeCharger.objects.filter(ra_node=ra_node)

        # 최근 10분 내 stat 집계
        window = timezone.now() - timedelta(minutes=10)
        result = []
        for ch in chargers:
            # 각 charger의 최신 로그
            latest_logs = (
                ChargerStatusLog.objects
                .filter(ra_node=ra_node, checked_at__gte=window)
                .order_by('charger_id', '-checked_at')
            )
            seen = {}
            for log in latest_logs:
                if log.charger_id not in seen:
                    seen[log.charger_id] = log.stat

            available = sum(1 for s in seen.values() if s == '2')
            charging  = sum(1 for s in seen.values() if s == '3')
            total     = len(seen)

            result.append({
                'stat_id':   ch.stat_id,
                'name':      ch.stat_name,
                'latitude':  str(ra_node.latitude),
                'longitude': str(ra_node.longitude),
                'available': available,
                'charging':  charging,
                'total':     total,
                'charger_cnt': ch.charger_cnt,
            })

        return Response({
            'node_id':   pk,
            'rest_area': ra_node.name,
            'stations':  result,
        })

# ──────────────────────────────────────────────
# GET /api/v1/nodes/nearest-ra/?lat=&lng=&limit=5
# ──────────────────────────────────────────────
def _haversine_km(lat1, lng1, lat2, lng2):
    import math
    R = 6371
    to_r = math.pi / 180
    d_lat = (lat2 - lat1) * to_r
    d_lng = (lng2 - lng1) * to_r
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(lat1 * to_r) * math.cos(lat2 * to_r) * math.sin(d_lng / 2) ** 2
    )
    return R * 2 * math.asin(math.sqrt(a))


class NearestRAView(APIView):
    """현재 위치 기준 가장 가까운 휴게소(RA) N개 — 홈 화면 원터치 진입용"""

    def get(self, request):
        try:
            lat = float(request.query_params.get('lat'))
            lng = float(request.query_params.get('lng'))
        except (TypeError, ValueError):
            return Response(
                {'detail': 'lat, lng 파라미터가 필요합니다.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            limit = int(request.query_params.get('limit', 5))
        except ValueError:
            limit = 5
        limit = max(1, min(limit, 20))

        ra_nodes = (
            HighwayNode.objects
            .filter(node_type='RA', is_active=True)
            .select_related('highway')
        )

        ranked = sorted(
            ra_nodes,
            key=lambda n: _haversine_km(lat, lng, float(n.latitude), float(n.longitude)),
        )[:limit]

        results = [{
            'id':           n.id,
            'name':         n.name,
            'highway_code': n.highway.code,
            'highway_name': n.highway.name,
            'direction':    n.direction,
            'latitude':     str(n.latitude),
            'longitude':    str(n.longitude),
            'distance_km':  round(_haversine_km(lat, lng, float(n.latitude), float(n.longitude)), 2),
        } for n in ranked]

        return Response({'stations': results})


# ──────────────────────────────────────────────
# 사용자 최근 방문 / 즐겨찾기 (userKey 기준)
# ──────────────────────────────────────────────
def _serialize_user_route(ur: UserRoute) -> dict:
    ra = ur.ra_node
    return {
        'ra_node_id':   ra.id,
        'name':         ra.name,
        'highway_code': ra.highway.code,
        'highway_name': ra.highway.name,
        'direction':    ra.direction,
        'is_favorite':  ur.is_favorite,
        'visit_count':  ur.visit_count,
        'last_used_at': ur.last_used_at.isoformat(),
    }


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
            'recent':    [_serialize_user_route(ur) for ur in recent],
            'favorites': [_serialize_user_route(ur) for ur in favorites],
        })

    def post(self, request):
        ra_node_id = request.data.get('ra_node_id')
        ra_node = get_object_or_404(HighwayNode, pk=ra_node_id, node_type='RA')

        obj, created = UserRoute.objects.get_or_create(
            user_key=self.user_key, ra_node=ra_node,
        )
        if not created:
            obj.visit_count = F('visit_count') + 1
            obj.save(update_fields=['visit_count', 'last_used_at'])
            obj.refresh_from_db()

        return Response(
            _serialize_user_route(obj),
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class UserRouteFavoriteView(UserScopedAPIView):
    """POST/DELETE /api/v1/me/routes/<ra_node_id>/favorite/ — 즐겨찾기 토글"""

    def post(self, request, ra_node_id):
        ra_node = get_object_or_404(HighwayNode, pk=ra_node_id, node_type='RA')
        obj, _ = UserRoute.objects.get_or_create(user_key=self.user_key, ra_node=ra_node)
        obj.is_favorite = True
        obj.save(update_fields=['is_favorite'])
        return Response(_serialize_user_route(obj))

    def delete(self, request, ra_node_id):
        UserRoute.objects.filter(
            user_key=self.user_key, ra_node_id=ra_node_id,
        ).update(is_favorite=False)
        return Response(status=status.HTTP_204_NO_CONTENT)


class UserRouteDeleteView(UserScopedAPIView):
    """DELETE /api/v1/me/routes/<ra_node_id>/ — 최근 목록에서 완전 삭제"""

    def delete(self, request, ra_node_id):
        UserRoute.objects.filter(
            user_key=self.user_key, ra_node_id=ra_node_id,
        ).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ──────────────────────────────────────────────
# 혼잡 해소 알림 구독 (메커니즘만 — 실제 발송은 toss_notify 참고)
# ──────────────────────────────────────────────
class CongestionNotifySubscribeView(UserScopedAPIView):
    """POST/DELETE /api/v1/nodes/<pk>/notify-me/"""

    def post(self, request, pk):
        ra_node = get_object_or_404(HighwayNode, pk=pk, node_type='RA', is_active=True)
        obj, created = CongestionNotifySubscription.objects.get_or_create(
            user_key=self.user_key, ra_node=ra_node,
            defaults={'is_active': True},
        )
        if not created and not obj.is_active:
            obj.is_active   = True
            obj.notified_at = None
            obj.save(update_fields=['is_active', 'notified_at'])
        return Response({'subscribed': True, 'rest_area': ra_node.name})

    def delete(self, request, pk):
        CongestionNotifySubscription.objects.filter(
            user_key=self.user_key, ra_node_id=pk,
        ).update(is_active=False)
        return Response(status=status.HTTP_204_NO_CONTENT)


def index_view(request):
    kakao_key = getattr(settings, 'KAKAO_JS_KEY', '') or getattr(settings, 'KAKAO_API_KEY', '')
    return render(request, 'index.html', {'kakao_key': kakao_key})