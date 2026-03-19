from django.urls import path
from . import views

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
]
