from rest_framework import serializers
from .models import Highway, HighwayNode, ChargingStation, NodeStationMapping


class HighwaySerializer(serializers.ModelSerializer):
    class Meta:
        model = Highway
        fields = ['id', 'code', 'name', 'total_distance_km']


class HighwayNodeSerializer(serializers.ModelSerializer):
    class Meta:
        model = HighwayNode
        fields = [
            'id', 'sequence', 'node_type', 'name',
            'latitude', 'longitude', 'distance_from_start_km',
        ]


class StationInBypassSerializer(serializers.Serializer):
    """bypass-stations 응답 내 충전소 표현 (Mapping 필드 포함)"""
    id              = serializers.IntegerField(source='station.id')
    name            = serializers.CharField(source='station.name')
    place_type      = serializers.CharField(source='station.place_type')
    latitude        = serializers.DecimalField(
        source='station.latitude', max_digits=9, decimal_places=6
    )
    longitude       = serializers.DecimalField(
        source='station.longitude', max_digits=9, decimal_places=6
    )
    power_kw        = serializers.IntegerField(source='station.power_kw', allow_null=True)
    charger_count   = serializers.IntegerField(source='station.charger_count')
    open_hours      = serializers.CharField(source='station.open_hours')
    distance_km     = serializers.FloatField()
    drive_minutes   = serializers.IntegerField()
    route_memo      = serializers.CharField()
    is_recommended  = serializers.BooleanField()


class ICWithStationsSerializer(serializers.Serializer):
    """bypass-stations 응답 내 IC 표현"""
    id                      = serializers.IntegerField()
    name                    = serializers.CharField()
    latitude                = serializers.DecimalField(max_digits=9, decimal_places=6)
    longitude               = serializers.DecimalField(max_digits=9, decimal_places=6)
    distance_from_start_km  = serializers.FloatField()
    stations                = StationInBypassSerializer(many=True)


class ChargingStationSerializer(serializers.ModelSerializer):
    class Meta:
        model = ChargingStation
        fields = [
            'id', 'name', 'address', 'place_type',
            'latitude', 'longitude',
            'charger_count', 'power_kw', 'operator',
            'open_hours', 'is_verified',
        ]
