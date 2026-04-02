from django.contrib import admin
from django.urls import path, include
from chargeflow.views import index_view, config_view

urlpatterns = [
    path('', index_view, name='index'),
    path('admin/', admin.site.urls),
    path('api/v1/', include('chargeflow.urls')),
    path('api/v1/config/', config_view),
]