from django.db import models


class Highway(models.Model):
    """경부 / 영동 / 서해안 고속도로 노선"""
    code                = models.CharField(max_length=20, unique=True)   # 'gyeongbu'
    name                = models.CharField(max_length=50)                # '경부고속도로'
    total_distance_km   = models.FloatField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = '고속도로'
        verbose_name_plural = '고속도로 목록'

    def __str__(self):
        return self.name


class HighwayNode(models.Model):
    """고속도로 위의 IC(나들목) 또는 RA(휴게소) 노드"""

    NODE_TYPE_CHOICES = [
        ('IC', 'IC (나들목)'),
        ('RA', 'RA (휴게소)'),
    ]
    DIRECTION_CHOICES = [
        ('UP',   '상행'),
        ('DOWN', '하행'),
    ]

    highway                 = models.ForeignKey(
        Highway, on_delete=models.CASCADE, related_name='nodes'
    )
    node_type               = models.CharField(max_length=2, choices=NODE_TYPE_CHOICES)
    direction               = models.CharField(max_length=4, choices=DIRECTION_CHOICES)
    sequence                = models.PositiveIntegerField()              # 방향 내 순서 (1~)
    name                    = models.CharField(max_length=100)
    latitude                = models.DecimalField(max_digits=9, decimal_places=6)
    longitude               = models.DecimalField(max_digits=9, decimal_places=6)
    distance_from_start_km  = models.FloatField()                       # 기점(상행 기준 종점)으로부터 거리
    is_active               = models.BooleanField(default=True)

    class Meta:
        verbose_name = '고속도로 노드'
        verbose_name_plural = '고속도로 노드 목록'
        unique_together = ('highway', 'direction', 'sequence')
        ordering = ['highway', 'direction', 'sequence']

    def __str__(self):
        return f'[{self.highway.code}/{self.direction}] {self.sequence}. {self.name} ({self.node_type})'


class ChargingStation(models.Model):
    """IC 진출 후 15분 이내 접근 가능한 급속 충전소"""

    PLACE_TYPE_CHOICES = [
        ('mart',        '대형 마트'),
        ('gas_station', '주유소'),
        ('hotel',       '호텔/모텔'),
        ('public',      '공공기관'),
        ('etc',         '기타'),
    ]

    name            = models.CharField(max_length=100)
    address         = models.CharField(max_length=200, blank=True)
    latitude        = models.DecimalField(max_digits=9, decimal_places=6)
    longitude       = models.DecimalField(max_digits=9, decimal_places=6)
    place_type      = models.CharField(max_length=20, choices=PLACE_TYPE_CHOICES, default='etc')
    charger_count   = models.PositiveSmallIntegerField(default=1)
    power_kw        = models.PositiveSmallIntegerField(null=True, blank=True)   # 50 / 100 / 200
    operator        = models.CharField(max_length=50, blank=True)
    open_hours      = models.CharField(max_length=50, blank=True)               # '24시간' 또는 '09:00-22:00'
    is_verified     = models.BooleanField(default=False)                        # 현장 검증 여부
    source_api_id   = models.CharField(max_length=50, unique=True, null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = '충전소'
        verbose_name_plural = '충전소 목록'

    def __str__(self):
        return f'{self.name} ({self.get_place_type_display()})'


class NodeStationMapping(models.Model):
    """IC 노드 ↔ 인근 충전소 연결 (바이패스 로직의 핵심)"""

    ic_node         = models.ForeignKey(
        HighwayNode, on_delete=models.CASCADE,
        related_name='nearby_stations',
        limit_choices_to={'node_type': 'IC'},
    )
    station         = models.ForeignKey(
        ChargingStation, on_delete=models.CASCADE,
        related_name='ic_mappings',
    )
    distance_km     = models.FloatField()                           # IC 출구 → 충전소 거리
    drive_minutes   = models.PositiveSmallIntegerField()            # 예상 소요 시간 (분)
    route_memo      = models.TextField(blank=True)                  # 'IC 진출 후 우회전 1.8km'
    is_recommended  = models.BooleanField(default=True)

    class Meta:
        verbose_name = 'IC-충전소 매핑'
        verbose_name_plural = 'IC-충전소 매핑 목록'
        unique_together = ('ic_node', 'station')
        ordering = ['drive_minutes', 'distance_km']

    def __str__(self):
        return f'{self.ic_node.name} → {self.station.name} ({self.drive_minutes}분)'

from django.db import models


class ChargerStatusLog(models.Model):
    """
    충전기 상태 변화 이력
    환경부 API getChargerStatus 호출 결과를 5분마다 저장
    """
    STAT_CHOICES = [
        ('1', '통신이상'),
        ('2', '충전가능'),
        ('3', '충전중'),
        ('4', '운영중지'),
        ('5', '점검중'),
        ('9', '상태미확인'),
    ]

    station     = models.ForeignKey(
        'ChargingStation', on_delete=models.CASCADE,
        related_name='status_logs'
    )
    charger_id  = models.CharField(max_length=10)   # chgerId (01, 02 ...)
    stat        = models.CharField(max_length=1, choices=STAT_CHOICES)
    checked_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name        = '충전기 상태 이력'
        verbose_name_plural = '충전기 상태 이력 목록'
        ordering            = ['-checked_at']
        indexes             = [
            models.Index(fields=['station', 'checked_at']),
        ]

    def __str__(self):
        return f'{self.station.name} [{self.charger_id}] {self.get_stat_display()} @ {self.checked_at:%H:%M}'


class StationCongestion(models.Model):
    """
    충전소별 혼잡도 집계 결과
    poll_charger_status 커맨드 실행마다 갱신
    """
    LEVEL_CHOICES = [
        ('smooth', '원활'),
        ('normal', '보통'),
        ('busy',   '혼잡'),
        ('jammed', '매우 혼잡'),
    ]

    station         = models.OneToOneField(
        'ChargingStation', on_delete=models.CASCADE,
        related_name='congestion'
    )
    change_count_30m = models.PositiveSmallIntegerField(default=0)
    # 30분 내 상태 변동 횟수 (≥5이면 혼잡 의심)
    level           = models.CharField(
        max_length=10, choices=LEVEL_CHOICES, default='smooth'
    )
    is_suspicious   = models.BooleanField(default=False)
    # True = 잦은 상태 변동 (고장 의심 충전기 존재)
    updated_at      = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name        = '충전소 혼잡도'
        verbose_name_plural = '충전소 혼잡도 목록'

    def __str__(self):
        flag = '⚠️' if self.is_suspicious else ''
        return f'{self.station.name} [{self.get_level_display()}] 변동{self.change_count_30m}회 {flag}'
