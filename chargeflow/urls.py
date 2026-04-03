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

    # 노선별 노드(IC/RA) 시퀀스
    path('highways/<str:code>/nodes/',
         views.NodeListView.as_view(),
         name='node-list'),

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

    # RA 반경 충전소
    path('nodes/<int:pk>/nearby-stations/',
         RANearbyStationsView.as_view(),
         name='ra-nearby-stations'),
] + static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)