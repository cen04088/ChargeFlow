from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
 
from .models import Highway, HighwayNode, ChargingStation, NodeStationMapping
from .serializers import (
    HighwaySerializer,
    HighwayNodeSerializer,
    ChargingStationSerializer,
)
 
 
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
    해당 RA(휴게소) 노드의 실제 혼잡도 반환.
    휴게소 내 충전기 상태 변동 기반으로 계산.
    """
 
    LEVEL_CONFIG = {
        'smooth':  {'label': '원활',      'color': 'green'},
        'normal':  {'label': '보통',      'color': 'blue'},
        'busy':    {'label': '혼잡',      'color': 'orange'},
        'jammed':  {'label': '매우 혼잡', 'color': 'red'},
        'unknown': {'label': '정보 없음', 'color': 'gray'},
    }
 
    def get(self, request, pk):
        try:
            ra_node = HighwayNode.objects.get(pk=pk, node_type='RA', is_active=True)
        except HighwayNode.DoesNotExist:
            return Response(
                {'detail': '해당 노드를 찾을 수 없습니다.'},
                status=status.HTTP_404_NOT_FOUND,
            )
 
        try:
            from chargeflow.models import StationCongestion
            cong = StationCongestion.objects.get(ra_node=ra_node)
            level = cong.level
            cfg   = self.LEVEL_CONFIG.get(level, self.LEVEL_CONFIG['unknown'])
            detail = (
                f'{ra_node.name} 충전기 중 일부에서 잦은 상태 변동이 감지됐어요. IC를 나가면 확실하게 충전할 수 있어요!'
                if cong.is_suspicious
                else f'{ra_node.name} 충전기가 정상 운영 중이에요.'
            )
            return Response({
                'node_id':   pk,
                'rest_area': ra_node.name,
                'level':     level,
                'label':     cfg['label'],
                'color':     cfg['color'],
                'is_suspicious': cong.is_suspicious,
                'detail':    detail,
            })
        except StationCongestion.DoesNotExist:
            # 폴링 데이터 아직 없음
            return Response({
                'node_id':   pk,
                'rest_area': ra_node.name,
                'level':     'unknown',
                'label':     '정보 없음',
                'color':     'gray',
                'is_suspicious': False,
                'detail':    '혼잡도 데이터를 수집 중이에요.',
            })
        except Exception:
            return Response({
                'node_id':   pk,
                'rest_area': ra_node.name,
                'level':     'unknown',
                'label':     '정보 없음',
                'color':     'gray',
                'is_suspicious': False,
                'detail':    '혼잡도 데이터를 준비 중이에요.',
            })
 