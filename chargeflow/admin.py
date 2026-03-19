from django.contrib import admin
from .models import Highway, HighwayNode, ChargingStation, NodeStationMapping


@admin.register(Highway)
class HighwayAdmin(admin.ModelAdmin):
    list_display = ['id', 'code', 'name', 'total_distance_km']
    search_fields = ['code', 'name']


@admin.register(HighwayNode)
class HighwayNodeAdmin(admin.ModelAdmin):
    list_display = ['id', 'highway', 'direction', 'sequence', 'node_type', 'name',
                    'distance_from_start_km', 'is_active']
    list_filter  = ['highway', 'direction', 'node_type', 'is_active']
    search_fields = ['name']
    ordering = ['highway', 'direction', 'sequence']


@admin.register(ChargingStation)
class ChargingStationAdmin(admin.ModelAdmin):
    list_display = ['id', 'name', 'place_type', 'power_kw', 'charger_count',
                    'open_hours', 'is_verified']
    list_filter  = ['place_type', 'is_verified']
    search_fields = ['name', 'address']


@admin.register(NodeStationMapping)
class NodeStationMappingAdmin(admin.ModelAdmin):
    list_display = ['id', 'ic_node', 'station', 'distance_km', 'drive_minutes', 'is_recommended']
    list_filter  = ['is_recommended', 'ic_node__highway', 'ic_node__direction']
    search_fields = ['ic_node__name', 'station__name']
    autocomplete_fields = ['ic_node', 'station']
