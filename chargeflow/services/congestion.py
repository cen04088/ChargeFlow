"""
휴게소 혼잡도 계산·직렬화
====================================================================
혼잡도는 "지금 바로 꽂을 수 있는 충전기가 몇 대인가"를 기준으로 한다.

  - 상태를 아는 충전기가 없음            → unknown     (정보 없음)
  - 운영 중(충전가능+충전중)인 충전기 0대 → unavailable (이용 불가: 점검·통신이상)
  - 충전가능 0대                         → jammed      (만석: 대기 필요)
  - 충전가능 / 운영 중 < 1/3             → busy        (혼잡)
  - 충전가능 / 운영 중 < 2/3             → normal      (보통)
  - 그 이상                              → smooth      (여유)

API는 폴러가 저장한 StationCongestion만 읽는다. 폴러가 멈춰 집계가 오래되면
(STALE_MINUTES) 화면에 틀린 정보를 보이지 않도록 unknown으로 내려준다.
"""
import math
from collections import defaultdict
from datetime import timedelta

from django.db.models import F
from django.utils import timezone

from chargeflow.models import (
    ChargerState, ChargerStatusLog, CongestionSample, HighwayNode, HighwayNodeCharger,
    StationCongestion,
)
from chargeflow.services.ev_api import KST

STALE_MINUTES = 30
SESSION_LIMIT_MIN = 40     # 고속도로 휴게소 급속충전 1회 이용 제한(40분)
EXIT_OVERHEAD_MIN = 4      # IC 진출·재진입(요금소 통과 등) 추가 시간
MIN_WAIT_MIN = 3           # 앞 차가 빠지고 새로 꽂는 데 드는 최소 시간
MIN_PATTERN_SAMPLES = 4    # 시간대 패턴을 보여주기 위한 최소 표본 수
STATION_STALE = timedelta(hours=12)

LEVEL_META = {
    'smooth':      {'label': '여유',     'color': 'green'},
    'normal':      {'label': '보통',     'color': 'blue'},
    'busy':        {'label': '혼잡',     'color': 'orange'},
    'jammed':      {'label': '만석',     'color': 'red'},
    'unavailable': {'label': '이용 불가', 'color': 'gray'},
    'unknown':     {'label': '정보 없음', 'color': 'gray'},
}


def compute_level(available, charging, offline):
    operating = available + charging
    if operating + offline == 0:
        return 'unknown'
    if operating == 0:
        return 'unavailable'
    if available == 0:
        return 'jammed'
    ratio = available / operating
    if ratio < 1 / 3:
        return 'busy'
    if ratio < 2 / 3:
        return 'normal'
    return 'smooth'


def recompute_all(now=None):
    """모든 RA의 혼잡도를 ChargerState로부터 다시 계산해 저장한다.
    반환: [(ra_node_id, 이전 level, 새 level)] — 레벨이 바뀐 RA만."""
    now = now or timezone.now()

    stat_ids_by_ra = defaultdict(set)
    for ra_id, stat_id in HighwayNodeCharger.objects.values_list('ra_node_id', 'stat_id'):
        stat_ids_by_ra[ra_id].add(stat_id)

    all_stat_ids = {s for ids in stat_ids_by_ra.values() for s in ids}
    stats_by_station = defaultdict(list)
    for stat_id, stat in ChargerState.objects.filter(stat_id__in=all_stat_ids).values_list('stat_id', 'stat'):
        stats_by_station[stat_id].append(stat)

    changes_by_station = defaultdict(int)
    window = now - timedelta(minutes=30)
    for stat_id in (ChargerStatusLog.objects
                    .filter(stat_id__in=all_stat_ids, checked_at__gte=window)
                    .values_list('stat_id', flat=True)):
        changes_by_station[stat_id] += 1

    existing = {c.ra_node_id: c for c in StationCongestion.objects.all()}
    transitions = []

    ra_ids = HighwayNode.objects.filter(node_type='RA', is_active=True).values_list('id', flat=True)
    for ra_id in ra_ids:
        stats = [s for sid in stat_ids_by_ra.get(ra_id, ()) for s in stats_by_station.get(sid, ())]
        available = sum(1 for s in stats if s == '2')
        charging  = sum(1 for s in stats if s == '3')
        offline   = len(stats) - available - charging
        level     = compute_level(available, charging, offline)
        turnover  = sum(changes_by_station.get(sid, 0) for sid in stat_ids_by_ra.get(ra_id, ()))

        row = existing.get(ra_id)
        prev_level = row.level if row else 'unknown'
        if row is None:
            row = StationCongestion(ra_node_id=ra_id)
        row.level            = level
        row.available        = available
        row.charging         = charging
        row.offline          = offline
        row.total            = len(stats)
        row.change_count_30m = min(turnover, 32767)
        row.save()

        if prev_level != level:
            transitions.append((ra_id, prev_level, level))

    return transitions


def serialize_congestion(row, now=None):
    """StationCongestion(또는 None) → API 응답용 dict"""
    now = now or timezone.now()
    if row is None or row.updated_at < now - timedelta(minutes=STALE_MINUTES):
        level = 'unknown'
    else:
        level = row.level

    meta = LEVEL_META[level]
    known = level != 'unknown'
    return {
        'level':      level,
        'label':      meta['label'],
        'color':      meta['color'],
        'available':  row.available if known else None,
        'charging':   row.charging if known else None,
        'offline':    row.offline if known else None,
        'total':      row.total if known else None,
        'turnover_30m': row.change_count_30m if known else None,
        'checked_at': row.updated_at.isoformat() if known else None,
    }


# ──────────────────────────────────────────────
# 혼잡 이력 · 통계 예측
# ──────────────────────────────────────────────
def record_samples(now=None):
    """현재 혼잡도를 요일·시간대 버킷에 한 표씩 더한다 (폴링 주기마다 호출)."""
    now   = now or timezone.now()
    local = now.astimezone(KST)
    rows  = StationCongestion.objects.exclude(level='unknown').values_list(
        'ra_node_id', 'level', 'available', 'charging',
    )
    for ra_id, level, available, charging in rows:
        operating = available + charging
        ratio     = (available / operating) if operating else 0.0
        waiting   = 1 if level in StationCongestion.WAITING_LEVELS else 0
        updated = CongestionSample.objects.filter(
            ra_node_id=ra_id, weekday=local.weekday(), hour=local.hour,
        ).update(
            samples=F('samples') + 1,
            waiting_samples=F('waiting_samples') + waiting,
            available_sum=F('available_sum') + ratio,
        )
        if not updated:
            CongestionSample.objects.create(
                ra_node_id=ra_id, weekday=local.weekday(), hour=local.hour,
                samples=1, waiting_samples=waiting, available_sum=ratio,
            )


def weekly_pattern(ra_id, weekday):
    """해당 요일 0~23시의 혼잡 확률(%) — 표본이 적은 시간대는 None"""
    buckets = {
        s.hour: s for s in CongestionSample.objects.filter(ra_node_id=ra_id, weekday=weekday)
    }
    hours = []
    for h in range(24):
        b = buckets.get(h)
        enough = b is not None and b.samples >= MIN_PATTERN_SAMPLES
        hours.append({
            'hour':         h,
            'waiting_rate': round(100 * b.waiting_samples / b.samples) if enough else None,
            'samples':      b.samples if b else 0,
        })
    return hours


def predict(ra_id, current_level, now=None, horizons=(1, 2)):
    """현재 상태와 같은 요일·시간대 평균을 섞어 h시간 뒤 혼잡 확률을 추정한다.
    가까운 미래일수록 지금 상태가, 멀수록 평소 패턴이 더 크게 반영된다."""
    now     = now or timezone.now()
    current = 1.0 if current_level in StationCongestion.WAITING_LEVELS else 0.0
    known   = current_level != 'unknown'
    result  = []
    for h in horizons:
        at     = (now + timedelta(hours=h)).astimezone(KST)
        bucket = CongestionSample.objects.filter(ra_node_id=ra_id, weekday=at.weekday(), hour=at.hour).first()
        hist   = (bucket.waiting_samples / bucket.samples) if bucket and bucket.samples >= MIN_PATTERN_SAMPLES else None
        if hist is None and not known:
            prob = None
        elif hist is None:
            prob = current  # 패턴이 쌓이기 전에는 지금 상태를 그대로 쓴다
        elif not known:
            prob = hist
        else:
            w    = math.exp(-h / 1.5)
            prob = w * current + (1 - w) * hist
        result.append({
            'hours_ahead': h,
            'at':          at.strftime('%H:00'),
            'probability': None if prob is None else round(prob * 100),
            'label':       None if prob is None else ('높음' if prob >= 0.6 else '보통' if prob >= 0.3 else '낮음'),
            'based_on_history': hist is not None,
        })
    return result


# ──────────────────────────────────────────────
# 대기 시간 추정 · 우회 비교
# ──────────────────────────────────────────────
def estimate_wait_minutes(ra_id, now=None):
    """빈 충전기가 없을 때, 충전 중인 충전기 중 가장 먼저 끝날 때까지 남은 시간(분).

    40분 제한을 10분 넘게 지난 충전기는 시작 시각 정보를 믿기 어려워 뺀다.
    차를 빼고 새로 꽂는 시간이 있으니 최소 MIN_WAIT_MIN분으로 본다.
    판단할 충전기가 없으면 None."""
    now = now or timezone.now()
    stat_ids = HighwayNodeCharger.objects.filter(ra_node_id=ra_id).values_list('stat_id', flat=True)
    remaining = []
    for since in (ChargerState.objects
                  .filter(stat_id__in=list(stat_ids), stat='3', charging_since__isnull=False)
                  .values_list('charging_since', flat=True)):
        elapsed = (now - since).total_seconds() / 60
        if 0 <= elapsed <= SESSION_LIMIT_MIN + 10:
            remaining.append(SESSION_LIMIT_MIN - elapsed)
    if not remaining:
        return None
    return max(MIN_WAIT_MIN, round(min(remaining)))


def detour_extra_minutes(drive_minutes):
    """IC로 나갔다가 충전소를 들러 다시 고속도로로 돌아오는 데 더 걸리는 시간(충전 시간 제외)"""
    return 2 * drive_minutes + EXIT_OVERHEAD_MIN


def station_realtime(stat_ids, now=None):
    """우회 충전소 statId → {'available', 'total', 'checked_at'} (12시간 넘게 보고가 없으면 제외)"""
    now = now or timezone.now()
    by_station = defaultdict(list)
    for stat_id, stat, updated in ChargerState.objects.filter(stat_id__in=stat_ids).values_list(
        'stat_id', 'stat', 'stat_updated_at',
    ):
        by_station[stat_id].append((stat, updated))
    result = {}
    for stat_id, rows in by_station.items():
        latest = max((u for _, u in rows if u), default=None)
        if latest is None or now - latest > STATION_STALE:
            continue
        result[stat_id] = {
            'available':  sum(1 for st, _ in rows if st == '2'),
            'total':      len(rows),
            'checked_at': latest.isoformat(),
        }
    return result
