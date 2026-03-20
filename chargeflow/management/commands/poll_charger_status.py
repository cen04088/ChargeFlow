"""
환경부 충전기 실시간 상태 폴링 + 혼잡도 계산
============================================================
실행:
  python manage.py poll_charger_status --api-key REDACTED_PUBLIC_DATA_API_KEY

스케줄러 (cron 예시 — 3분마다):
  */3 * * * * cd /path/to/chargeflow && venv/bin/python manage.py poll_charger_status --api-key KEY

혼잡 판단 기준:
  - 30분 내 같은 충전기의 상태(stat)가 5회 이상 변동 → 고장 의심 → is_suspicious=True
  - 3분마다 폴링 → 30분 윈도우 내 최대 10회 수집
  - 해당 충전소의 suspicious 충전기 비율:
      0%     → smooth (원활)
      1~30%  → normal (보통)
      31~60% → busy   (혼잡)
      61%+   → jammed (매우 혼잡)
"""
import json, time
import urllib.request, urllib.parse
from datetime import timedelta
 
from django.core.management.base import BaseCommand
from django.utils import timezone
 
from chargeflow.models import HighwayNode, HighwayNodeCharger, ChargerStatusLog, StationCongestion
 
API_URL          = 'https://apis.data.go.kr/B552584/EvCharger/getChargerStatus'
CHANGE_THRESHOLD = 5
WINDOW_MINUTES   = 30
 
LEVEL_MAP = [
    (0.00, 'smooth'),
    (0.30, 'normal'),
    (0.60, 'busy'),
    (1.01, 'jammed'),
]
 
 
def fetch_status(api_key, stat_id):
    params = urllib.parse.urlencode({
        'serviceKey': api_key,
        'pageNo':     1,
        'numOfRows':  50,
        'dataType':   'JSON',
        'statId':     stat_id,
    })
    try:
        req = urllib.request.Request(
            f'{API_URL}?{params}',
            headers={'Accept': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=10) as res:
            data = json.loads(res.read().decode('utf-8'))
        body  = data.get('body') or data
        items = body.get('items') or {}
        if isinstance(items, dict):
            items = items.get('item') or []
        if isinstance(items, dict):
            items = [items]
        return items or []
    except Exception:
        return []
 
 
def calc_change_count(ra_node, charger_id, window_start):
    logs = list(
        ChargerStatusLog.objects.filter(
            ra_node=ra_node,
            charger_id=charger_id,
            checked_at__gte=window_start,
        ).order_by('checked_at').values_list('stat', flat=True)
    )
    if len(logs) < 2:
        return 0
    changes, prev = 0, logs[0]
    for curr in logs[1:]:
        if curr != prev:
            changes += 1
        prev = curr
    return changes
 
 
def calc_congestion_level(ra_node, all_charger_ids, window):
    """충전기 목록 기준 혼잡도 레벨 계산"""
    total = len(set(all_charger_ids))
    if total == 0:
        return 'smooth', 0, 0
 
    suspicious = 0
    for cid in set(all_charger_ids):
        if calc_change_count(ra_node, cid, window) >= CHANGE_THRESHOLD:
            suspicious += 1
 
    ratio = suspicious / total
    level = next(lv for threshold, lv in LEVEL_MAP if ratio <= threshold)
    return level, suspicious, total
 
 
def poll_and_log(api_key, ra_node, chargers, window):
    """
    chargers 목록의 statId로 API 호출 → 로그 저장 → charger_id 목록 반환
    """
    all_charger_ids = []
 
    for ch in chargers:
        items = fetch_status(api_key, ch.stat_id)
        if not items:
            time.sleep(0.1)
            continue
 
        for item in items:
            charger_id = str(item.get('chgerId') or '').strip()
            stat       = str(item.get('stat') or '9').strip()
            if not charger_id:
                continue
 
            all_charger_ids.append(charger_id)
 
            last = ChargerStatusLog.objects.filter(
                ra_node=ra_node,
                charger_id=charger_id,
            ).order_by('-checked_at').first()
 
            if last is None or last.stat != stat:
                ChargerStatusLog.objects.create(
                    ra_node=ra_node,
                    charger_id=charger_id,
                    stat=stat,
                )
 
        time.sleep(0.05)
 
    return all_charger_ids
 
 
class Command(BaseCommand):
    help = '고속도로 휴게소 충전기 상태 폴링 (상하행 분리/공용 자동 처리)'
 
    def add_arguments(self, parser):
        parser.add_argument('--api-key', required=True)
        parser.add_argument('--limit',   type=int, default=None)
        parser.add_argument('--verbose', action='store_true')
 
    def handle(self, *args, **options):
        api_key = options['api_key']
        limit   = options['limit']
        verbose = options['verbose']
        now     = timezone.now()
        window  = now - timedelta(minutes=WINDOW_MINUTES)
 
        # ── 휴게소 이름별로 UP/DOWN 노드 묶기 ─────────────
        # { (hw_code, ra_name): {'UP': node, 'DOWN': node, 'UP_chargers': [...], 'DOWN_chargers': [...]} }
        charger_qs = HighwayNodeCharger.objects.select_related(
            'ra_node__highway'
        ).order_by('ra_node__highway', 'ra_node__name', 'ra_node__direction')
 
        if limit:
            # limit은 휴게소 개수 기준
            ra_names = list(
                charger_qs.values_list('ra_node__highway__code', 'ra_node__name')
                .distinct()[:limit]
            )
            charger_qs = charger_qs.filter(
                ra_node__highway__code__in=[r[0] for r in ra_names],
                ra_node__name__in=[r[1] for r in ra_names],
            )
 
        groups = {}
        for ch in charger_qs:
            hw_code   = ch.ra_node.highway.code
            ra_name   = ch.ra_node.name
            direction = ch.ra_node.direction
            key       = (hw_code, ra_name)
 
            if key not in groups:
                groups[key] = {
                    'UP':          None, 'DOWN':          None,
                    'UP_chargers': [],   'DOWN_chargers': [],
                }
            groups[key][direction]              = ch.ra_node
            groups[key][f'{direction}_chargers'].append(ch)
 
        total = len(groups)
        suspicious_total = 0
 
        self.stdout.write(f'\n⚡ 휴게소 충전기 폴링 시작 ({total}개 휴게소)\n')
 
        for (hw_code, ra_name), g in groups.items():
            up_node   = g['UP']
            down_node = g['DOWN']
            up_ch     = g['UP_chargers']
            down_ch   = g['DOWN_chargers']
 
            # ── 공용 여부 판별: statId 집합이 같으면 공용 ──
            up_ids   = set(c.stat_id for c in up_ch)
            down_ids = set(c.stat_id for c in down_ch)
            is_shared = bool(up_ids and down_ids and up_ids == down_ids)
 
            if is_shared:
                # ── 공용 휴게소: 대표 노드(있는 것)로 한 번만 폴링 ──
                rep_node = up_node or down_node
                rep_ch   = up_ch or down_ch
                charger_ids = poll_and_log(api_key, rep_node, rep_ch, window)
                level, suspicious, total_c = calc_congestion_level(rep_node, charger_ids, window)
 
                # UP/DOWN 둘 다 같은 혼잡도 저장
                for node in filter(None, [up_node, down_node]):
                    StationCongestion.objects.update_or_create(
                        ra_node=node,
                        defaults={
                            'change_count_30m': suspicious,
                            'level':            level,
                            'is_suspicious':    suspicious > 0,
                        }
                    )
 
                label = '🔄 공용'
                if suspicious > 0:
                    suspicious_total += 1
                    self.stdout.write(f'  🟠 {ra_name:<22} {label}  의심 {suspicious}/{total_c}기 → {level}')
                elif verbose:
                    self.stdout.write(f'  🟢 {ra_name:<22} {label}  정상 ({total_c}기)')
 
            else:
                # ── 분리 휴게소: 방향별로 각각 폴링 ──
                dir_suspicious = False
 
                for direction, node, chargers in [
                    ('DOWN', down_node, down_ch),
                    ('UP',   up_node,   up_ch),
                ]:
                    if not node or not chargers:
                        continue
 
                    charger_ids = poll_and_log(api_key, node, chargers, window)
                    level, suspicious, total_c = calc_congestion_level(node, charger_ids, window)
 
                    StationCongestion.objects.update_or_create(
                        ra_node=node,
                        defaults={
                            'change_count_30m': suspicious,
                            'level':            level,
                            'is_suspicious':    suspicious > 0,
                        }
                    )
 
                    dir_label = '⬇️ 하행' if direction == 'DOWN' else '⬆️ 상행'
                    if suspicious > 0:
                        dir_suspicious = True
                        self.stdout.write(
                            f'  🟠 {ra_name:<22} {dir_label}  의심 {suspicious}/{total_c}기 → {level}'
                        )
                    elif verbose:
                        self.stdout.write(
                            f'  🟢 {ra_name:<22} {dir_label}  정상 ({total_c}기)'
                        )
 
                if dir_suspicious:
                    suspicious_total += 1
 
        # 2시간 이상 오래된 로그 정리
        cutoff = now - timedelta(hours=2)
        deleted, _ = ChargerStatusLog.objects.filter(checked_at__lt=cutoff).delete()
 
        self.stdout.write(self.style.SUCCESS(
            f'\n✅ 완료: {total}개 휴게소 / 의심: {suspicious_total}개 / 오래된 로그 {deleted}개 삭제'
        ))