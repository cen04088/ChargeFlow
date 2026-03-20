from django.db import models
 
 
class Highway(models.Model):
    code              = models.CharField(max_length=20, unique=True)
    name              = models.CharField(max_length=50)
    total_distance_km = models.FloatField(null=True, blank=True)
    created_at        = models.DateTimeField(auto_now_add=True)
 
    class Meta:
        verbose_name = '고속도로'
        verbose_name_plural = '고속도로 목록'
 
    def __str__(self):
        return self.name
 
 
class HighwayNode(models.Model):
    NODE_TYPE_CHOICES = [('IC', 'IC (나들목)'), ('RA', 'RA (휴게소)')]
    DIRECTION_CHOICES = [('UP', '상행'), ('DOWN', '하행')]
 
    highway                = models.ForeignKey(Highway, on_delete=models.CASCADE, related_name='nodes')
    node_type              = models.CharField(max_length=2, choices=NODE_TYPE_CHOICES)
    direction              = models.CharField(max_length=4, choices=DIRECTION_CHOICES)
    sequence               = models.PositiveIntegerField()
    name                   = models.CharField(max_length=100)
    latitude               = models.DecimalField(max_digits=9, decimal_places=6)
    longitude              = models.DecimalField(max_digits=9, decimal_places=6)
    distance_from_start_km = models.FloatField()
    is_active              = models.BooleanField(default=True)
 
    class Meta:
        verbose_name        = '고속도로 노드'
        verbose_name_plural = '고속도로 노드 목록'
        unique_together     = ('highway', 'direction', 'sequence')
        ordering            = ['highway', 'direction', 'sequence']
 
    def __str__(self):
        return f'[{self.highway.code}/{self.direction}] {self.sequence}. {self.name} ({self.node_type})'
 
 
class ChargingStation(models.Model):
    PLACE_TYPE_CHOICES = [
        ('mart',        '대형 마트'),
        ('gas_station', '주유소'),
        ('hotel',       '호텔/모텔'),
        ('public',      '공공기관'),
        ('etc',         '기타'),
    ]
 
    name          = models.CharField(max_length=100)
    address       = models.CharField(max_length=200, blank=True)
    latitude      = models.DecimalField(max_digits=9, decimal_places=6)
    longitude     = models.DecimalField(max_digits=9, decimal_places=6)
    place_type    = models.CharField(max_length=20, choices=PLACE_TYPE_CHOICES, default='etc')
    charger_count = models.PositiveSmallIntegerField(default=1)
    power_kw      = models.PositiveSmallIntegerField(null=True, blank=True)
    operator      = models.CharField(max_length=50, blank=True)
    open_hours    = models.CharField(max_length=50, blank=True)
    is_verified   = models.BooleanField(default=False)
    source_api_id = models.CharField(max_length=50, unique=True, null=True, blank=True)
    created_at    = models.DateTimeField(auto_now_add=True)
    updated_at    = models.DateTimeField(auto_now=True)
 
    class Meta:
        verbose_name        = '충전소'
        verbose_name_plural = '충전소 목록'
 
    def __str__(self):
        return f'{self.name} ({self.get_place_type_display()})'
 
 
class NodeStationMapping(models.Model):
    ic_node        = models.ForeignKey(
        HighwayNode, on_delete=models.CASCADE,
        related_name='nearby_stations',
        limit_choices_to={'node_type': 'IC'},
    )
    station        = models.ForeignKey(
        ChargingStation, on_delete=models.CASCADE,
        related_name='ic_mappings',
    )
    distance_km    = models.FloatField()
    drive_minutes  = models.PositiveSmallIntegerField()
    route_memo     = models.TextField(blank=True)
    is_recommended = models.BooleanField(default=True)
 
    class Meta:
        verbose_name        = 'IC-충전소 매핑'
        verbose_name_plural = 'IC-충전소 매핑 목록'
        unique_together     = ('ic_node', 'station')
        ordering            = ['drive_minutes', 'distance_km']
 
    def __str__(self):
        return f'{self.ic_node.name} → {self.station.name} ({self.drive_minutes}분)'
 
 
class HighwayNodeCharger(models.Model):
    """휴게소(RA) ↔ 환경부 충전소 statId 매핑"""
 
    ra_node     = models.ForeignKey(
        HighwayNode, on_delete=models.CASCADE,
        related_name='chargers',
        limit_choices_to={'node_type': 'RA'},
    )
    stat_id     = models.CharField(max_length=20)
    stat_name   = models.CharField(max_length=100)
    charger_cnt = models.PositiveSmallIntegerField(default=0)
 
    class Meta:
        verbose_name        = '휴게소 충전기 매핑'
        verbose_name_plural = '휴게소 충전기 매핑 목록'
        unique_together     = ('ra_node', 'stat_id')
 
    def __str__(self):
        return f'{self.ra_node.name} → {self.stat_name} ({self.stat_id})'
 
 
class ChargerStatusLog(models.Model):
    """휴게소 충전기 상태 변화 이력"""
 
    STAT_CHOICES = [
        ('1', '통신이상'), ('2', '충전가능'), ('3', '충전중'),
        ('4', '운영중지'), ('5', '점검중'),   ('9', '상태미확인'),
    ]
 
    ra_node    = models.ForeignKey(
        HighwayNode, on_delete=models.CASCADE,
        related_name='status_logs',
        limit_choices_to={'node_type': 'RA'},
    )
    charger_id = models.CharField(max_length=10)
    stat       = models.CharField(max_length=1, choices=STAT_CHOICES)
    checked_at = models.DateTimeField(auto_now_add=True)
 
    class Meta:
        verbose_name        = '충전기 상태 이력'
        verbose_name_plural = '충전기 상태 이력 목록'
        ordering            = ['-checked_at']
        indexes             = [models.Index(fields=['ra_node', 'checked_at'])]
 
    def __str__(self):
        return f'{self.ra_node.name} [{self.charger_id}] {self.get_stat_display()}'
 
 
class StationCongestion(models.Model):
    """휴게소(RA)별 혼잡도 집계 결과"""
 
    LEVEL_CHOICES = [
        ('smooth', '원활'),
        ('normal', '보통'),
        ('busy',   '혼잡'),
        ('jammed', '매우 혼잡'),
    ]
 
    ra_node          = models.OneToOneField(
        HighwayNode, on_delete=models.CASCADE,
        related_name='congestion',
        limit_choices_to={'node_type': 'RA'},
    )
    change_count_30m = models.PositiveSmallIntegerField(default=0)
    level            = models.CharField(max_length=10, choices=LEVEL_CHOICES, default='smooth')
    is_suspicious    = models.BooleanField(default=False)
    updated_at       = models.DateTimeField(auto_now=True)
 
    class Meta:
        verbose_name        = '휴게소 혼잡도'
        verbose_name_plural = '휴게소 혼잡도 목록'
 
    def __str__(self):
        return f'{self.ra_node.name} [{self.get_level_display()}]'