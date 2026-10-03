from django.contrib import admin
from .models import (
    Highway, HighwayNode, ChargingStation, NodeStationMapping,
    HighwayNodeCharger, ChargerState, ChargerStatusLog, StationCongestion,
    PollerStatus, UserRoute, CongestionNotifySubscription,
)


@admin.register(Highway)
class HighwayAdmin(admin.ModelAdmin):
    list_display  = ['id', 'code', 'name', 'total_distance_km']
    search_fields = ['code', 'name']


@admin.register(HighwayNode)
class HighwayNodeAdmin(admin.ModelAdmin):
    list_display  = ['id', 'highway', 'direction', 'sequence', 'node_type', 'name',
                     'distance_from_start_km', 'is_active']
    list_filter   = ['highway', 'direction', 'node_type', 'is_active']
    search_fields = ['name']
    ordering      = ['highway', 'direction', 'sequence']


@admin.register(ChargingStation)
class ChargingStationAdmin(admin.ModelAdmin):
    list_display  = ['id', 'name', 'place_type', 'power_kw', 'charger_count',
                     'open_hours', 'is_verified', 'kakao_place_id']
    list_filter   = ['place_type', 'is_verified']
    search_fields = ['name', 'address']


@admin.register(NodeStationMapping)
class NodeStationMappingAdmin(admin.ModelAdmin):
    list_display        = ['id', 'ic_node', 'station', 'distance_km', 'drive_minutes', 'is_recommended']
    list_filter         = ['is_recommended', 'ic_node__highway', 'ic_node__direction']
    search_fields       = ['ic_node__name', 'station__name']
    autocomplete_fields = ['ic_node', 'station']


@admin.register(HighwayNodeCharger)
class HighwayNodeChargerAdmin(admin.ModelAdmin):
    list_display  = ['id', 'ra_node', 'stat_id', 'stat_name', 'charger_cnt']
    list_filter   = ['ra_node__highway']
    search_fields = ['ra_node__name', 'stat_id', 'stat_name']


@admin.register(ChargerState)
class ChargerStateAdmin(admin.ModelAdmin):
    list_display  = ['id', 'stat_id', 'charger_id', 'stat', 'stat_updated_at', 'zcode', 'synced_at']
    list_filter   = ['stat', 'zcode']
    search_fields = ['stat_id']


@admin.register(ChargerStatusLog)
class ChargerStatusLogAdmin(admin.ModelAdmin):
    list_display  = ['id', 'stat_id', 'charger_id', 'stat', 'checked_at']
    list_filter   = ['stat']
    search_fields = ['stat_id', 'charger_id']
    ordering      = ['-checked_at']


@admin.register(StationCongestion)
class StationCongestionAdmin(admin.ModelAdmin):
    list_display  = ['id', 'ra_node', 'level', 'available', 'charging', 'offline', 'total',
                     'change_count_30m', 'updated_at']
    list_filter   = ['level']
    search_fields = ['ra_node__name']


@admin.register(UserRoute)
class UserRouteAdmin(admin.ModelAdmin):
    list_display  = ['id', 'user_key', 'ra_node', 'is_favorite', 'visit_count', 'last_used_at']
    list_filter   = ['is_favorite', 'ra_node__highway']
    search_fields = ['user_key', 'ra_node__name']
    ordering      = ['-last_used_at']


@admin.register(CongestionNotifySubscription)
class CongestionNotifySubscriptionAdmin(admin.ModelAdmin):
    list_display  = ['id', 'user_key', 'ra_node', 'is_active', 'subscribed_at', 'notified_at']
    list_filter   = ['is_active', 'ra_node__highway']
    search_fields = ['user_key', 'ra_node__name']
    ordering      = ['-created_at']

@admin.register(PollerStatus)
class PollerStatusAdmin(admin.ModelAdmin):
    list_display = ['key', 'last_status_at', 'last_baseline_at', 'updated_at']
