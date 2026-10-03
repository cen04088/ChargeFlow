from django.urls import path
from chargeflow import views
from chargeflow.views import RANearbyStationsView
from django.conf import settings
from django.conf.urls.static import static


urlpatterns = [
    # 고속도로 목록
    path('highways/',
         views.HighwayListView.as_view(),
         name='highway-list'),

    # 구간(여행) 모드: 출발~도착 사이 휴게소와 도착 시각 기준 혼잡 예측
    path('highways/<str:code>/trip/',
         views.TripView.as_view(),
         name='highway-trip'),

    # 노선별 노드(IC/RA) 시퀀스
    path('highways/<str:code>/nodes/',
         views.NodeListView.as_view(),
         name='node-list'),

    # 홈 화면 원터치 진입: 현재 위치 기준 가장 가까운 휴게소
    path('nodes/nearest-ra/',
         views.NearestRAView.as_view(),
         name='nearest-ra'),

    # 핵심: 우회 충전소 추천
    path('nodes/<int:pk>/bypass-stations/',
         views.BypassStationView.as_view(),
         name='bypass-stations'),

    # 충전소 상세
    path('stations/<int:pk>/',
         views.StationDetailView.as_view(),
         name='station-detail'),

    # 혼잡도
    path('nodes/<int:pk>/congestion/',
         views.NodeCongestionView.as_view(),
         name='node-congestion'),

    # 요일·시간대별 혼잡 패턴 + 예측
    path('nodes/<int:pk>/pattern/',
         views.NodePatternView.as_view(),
         name='node-pattern'),

    # 혼잡 해소 알림 구독
    path('nodes/<int:pk>/notify-me/',
         views.CongestionNotifySubscribeView.as_view(),
         name='node-notify-me'),

    # RA 반경 충전소
    path('nodes/<int:pk>/nearby-stations/',
         RANearbyStationsView.as_view(),
         name='ra-nearby-stations'),

    # 사용자 최근 방문 / 즐겨찾기
    path('me/routes/',
         views.UserRouteListView.as_view(),
         name='user-route-list'),
    path('me/routes/<int:ra_node_id>/favorite/',
         views.UserRouteFavoriteView.as_view(),
         name='user-route-favorite'),
    path('me/routes/<int:ra_node_id>/notify/',
         views.UserRouteNotifyView.as_view(),
         name='user-route-notify'),
    path('me/settings/',
         views.UserSettingView.as_view(),
         name='user-settings'),
    path('me/routes/<int:ra_node_id>/',
         views.UserRouteDeleteView.as_view(),
         name='user-route-delete'),
] + static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)