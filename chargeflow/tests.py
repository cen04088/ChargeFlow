from datetime import datetime, timedelta
from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import IntegrityError
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from chargeflow.management.commands import poll_charger_status as poller
from chargeflow.models import (
    ChargerState, ChargerStatusLog, CongestionNotifySubscription, Highway, HighwayNode,
    HighwayNodeCharger, PollerStatus, PublicStation, StationCongestion, UserRoute,
)
from chargeflow.services import ev_api
from chargeflow.services.congestion import compute_level, recompute_all
from chargeflow.services.nearby import PUBLIC_STALE, in_korea, search_nearby, station_status
from chargeflow.services.public_catalog import deactivate_missing, freshness_report, is_public_fast, sync_items


def item(stat_id, charger_id, stat, upd='20261003120000', zcode='41'):
    return {'statId': stat_id, 'chgerId': charger_id, 'stat': stat, 'statUpdDt': upd, 'zcode': zcode}


class Fixture(TestCase):
    def setUp(self):
        hw = Highway.objects.create(code='gyeongbu', name='경부고속도로')

        def node(direction, seq, node_type, name, lat=37.0, lng=127.0):
            return HighwayNode.objects.create(
                highway=hw, node_type=node_type, direction=direction, sequence=seq,
                name=name, latitude=lat, longitude=lng, distance_from_start_km=seq,
            )

        self.ra_down = node('DOWN', 2, 'RA', '기흥휴게소', 37.2, 127.1)
        self.ra_up   = node('UP', 2, 'RA', '기흥휴게소', 37.2, 127.1)
        self.ra_far  = node('DOWN', 3, 'RA', '망향휴게소', 36.8, 127.2)
        # 기흥은 상하행 공용 충전소(ST1), 망향은 단독(ST2)
        for ra in (self.ra_down, self.ra_up):
            HighwayNodeCharger.objects.create(ra_node=ra, stat_id='ST1', stat_name='기흥', charger_cnt=3)
        HighwayNodeCharger.objects.create(ra_node=self.ra_far, stat_id='ST2', stat_name='망향', charger_cnt=2)

    def run_poll(self, baseline_items=(), status_items=(), force_baseline=False, station_items=None):
        """baseline_items: 휴게소 분류 응답, station_items: statId별 개별 조회 응답"""
        station_items = station_items or {}
        with mock.patch.object(poller.ev_api, 'fetch_rest_area_chargers',
                               return_value=list(baseline_items)), \
             mock.patch.object(poller.ev_api, 'fetch_station',
                               side_effect=lambda key, sid: station_items.get(sid, [])) as station, \
             mock.patch.object(poller.ev_api, 'fetch_status_changes',
                               return_value=list(status_items)):
            poller.run_cycle('KEY', StringIO(), force_baseline=force_baseline)
        return station


class ComputeLevelTests(TestCase):
    def test_levels(self):
        self.assertEqual(compute_level(0, 0, 0), 'unknown')
        self.assertEqual(compute_level(0, 0, 2), 'unavailable')
        self.assertEqual(compute_level(0, 3, 0), 'jammed')
        self.assertEqual(compute_level(1, 3, 0), 'busy')      # 1/4
        self.assertEqual(compute_level(1, 1, 0), 'normal')    # 1/2
        self.assertEqual(compute_level(3, 1, 1), 'smooth')    # 3/4, 고장 1대는 비율에서 제외


class PollerTests(Fixture):
    def test_first_run_does_baseline_and_ignores_untracked(self):
        self.run_poll(
            baseline_items=[item('ST1', '01', '2'), item('ST1', '02', '3'), item('XX', '01', '2')],
        )
        self.assertEqual(ChargerState.objects.count(), 2)
        self.assertIsNotNone(PollerStatus.objects.get(key='charger').last_baseline_at)

        # 공용 충전소는 상하행 모두 같은 혼잡도
        down = StationCongestion.objects.get(ra_node=self.ra_down)
        up   = StationCongestion.objects.get(ra_node=self.ra_up)
        self.assertEqual((down.available, down.charging, down.level), (1, 1, 'normal'))
        self.assertEqual(up.level, 'normal')
        self.assertEqual(StationCongestion.objects.get(ra_node=self.ra_far).level, 'unknown')

    def test_public_station_is_updated_but_not_created_or_logged(self):
        PublicStation.objects.create(stat_id='PUB00001', name='공영', latitude=37.25, longitude=127.07,
                                     power_kw=100, charger_count=1)
        ChargerState.objects.create(stat_id='PUB00001', charger_id='01', stat='2', output_kw=100)
        items = [{'statId': 'PUB00001', 'chgerId': '01', 'stat': '3', 'statUpdDt': '20261119120000'},
                 {'statId': 'PUB00001', 'chgerId': '99', 'stat': '2', 'statUpdDt': '20261119120000'}]
        poller._apply_items(items, {'PUB00001'}, timezone.now(), create_for=set(), log_for=set())
        self.assertEqual(ChargerState.objects.get(stat_id='PUB00001', charger_id='01').stat, '3')
        self.assertFalse(ChargerState.objects.filter(charger_id='99').exists())
        self.assertFalse(ChargerStatusLog.objects.filter(stat_id='PUB00001').exists())

    def test_defaults_keep_existing_behaviour(self):
        poller._apply_items([{'statId': 'NEW00001', 'chgerId': '01', 'stat': '2'}], {'NEW00001'}, timezone.now())
        self.assertTrue(ChargerState.objects.filter(stat_id='NEW00001').exists())
        self.assertEqual(ChargerStatusLog.objects.filter(stat_id='NEW00001').count(), 1)

    def test_batching_does_not_change_results(self):
        for cid in ('01', '02', '03'):
            ChargerState.objects.create(stat_id='ST1', charger_id=cid, stat='2')
        with mock.patch.object(poller, 'BULK_BATCH_SIZE', 1):
            poller._apply_items([item('ST1', c, '3') for c in ('01', '02', '03')], {'ST1'}, timezone.now())
        self.assertEqual(list(ChargerState.objects.filter(stat_id='ST1').values_list('stat', flat=True)), ['3'] * 3)

    def test_apply_items_accepts_generator(self):
        gen = (i for i in [item('ST1', '01', '2')])
        poller._apply_items(gen, {'ST1'}, timezone.now())
        self.assertTrue(ChargerState.objects.filter(stat_id='ST1', charger_id='01').exists())

    def test_run_cycle_tracks_public_stations(self):
        PublicStation.objects.create(stat_id='PUB00001', name='공영', latitude=37.25, longitude=127.07,
                                     power_kw=100, charger_count=1)
        ChargerState.objects.create(stat_id='PUB00001', charger_id='01', stat='2', output_kw=100)
        self.run_poll(
            baseline_items=[item('ST1', '01', '2'), item('ST1', '02', '3')],
            status_items=[item('PUB00001', '01', '3', '20261119120000'),
                          item('PUB00001', '99', '2', '20261119120000'),
                          item('XX', '01', '2')],
        )
        self.assertEqual(ChargerState.objects.get(stat_id='PUB00001', charger_id='01').stat, '3')
        self.assertFalse(ChargerState.objects.filter(stat_id='PUB00001', charger_id='99').exists())
        self.assertFalse(ChargerState.objects.filter(stat_id='XX').exists())
        self.assertFalse(ChargerStatusLog.objects.filter(stat_id='PUB00001').exists())
        # 휴게소 혼잡도는 기존 테스트와 같은 결과
        down = StationCongestion.objects.get(ra_node=self.ra_down)
        self.assertEqual((down.available, down.charging, down.level), (1, 1, 'normal'))
        self.assertEqual(StationCongestion.objects.get(ra_node=self.ra_far).level, 'unknown')

    def test_baseline_fills_missing_stations_by_stat_id(self):
        station = self.run_poll(
            baseline_items=[item('ST1', '01', '2')],
            station_items={'ST2': [item('ST2', '01', '3')]},
        )
        station.assert_called_once_with('KEY', 'ST2')  # 분류에 없는 충전소만 개별 조회
        self.assertEqual(ChargerState.objects.get(stat_id='ST2').stat, '3')

    def test_incremental_update_skips_baseline_and_logs_changes(self):
        self.run_poll(baseline_items=[item('ST1', '01', '2'), item('ST1', '02', '2')])
        with mock.patch.object(poller.ev_api, 'fetch_rest_area_chargers') as info, \
             mock.patch.object(poller.ev_api, 'fetch_status_changes',
                               return_value=[item('ST1', '01', '3', '20261003121000')]):
            poller.run_cycle('KEY', StringIO())
        info.assert_not_called()
        self.assertEqual(ChargerState.objects.get(stat_id='ST1', charger_id='01').stat, '3')
        self.assertEqual(ChargerStatusLog.objects.filter(stat_id='ST1', charger_id='01').count(), 2)

    def test_older_event_does_not_overwrite_newer_state(self):
        self.run_poll(baseline_items=[item('ST1', '01', '3', '20261003121000')])
        self.run_poll(status_items=[item('ST1', '01', '2', '20261003120000')])
        self.assertEqual(ChargerState.objects.get(stat_id='ST1', charger_id='01').stat, '3')

    def test_gap_triggers_light_resync_only(self):
        self.run_poll(baseline_items=[item('ST1', '01', '2')])
        PollerStatus.objects.filter(key='charger').update(
            last_status_at=timezone.now() - timedelta(minutes=11),  # 10분 크론 + 기동 지연
        )
        station = self.run_poll(baseline_items=[item('ST1', '01', '3', '20261003130000')])
        self.assertEqual(ChargerState.objects.get(stat_id='ST1', charger_id='01').stat, '3')
        station.assert_not_called()  # 개별 조회(전체 기준선)는 하루 1회만

    def test_api_error_skips_cycle_unless_outage_is_long(self):
        self.run_poll(baseline_items=[item('ST1', '01', '2')])
        last_ok = PollerStatus.objects.get(key='charger').last_status_at
        err = poller.ev_api.EvApiError('getChargerStatus 요청 실패(3회 시도): HTTP Error 504: Gateway Timeout')

        # 직전 성공이 최근이면 크론을 실패로 끝내지 않는다
        with mock.patch.object(poller.ev_api, 'fetch_status_changes', side_effect=err):
            poller.run_cycle('KEY', StringIO())
        status = PollerStatus.objects.get(key='charger')
        self.assertEqual(status.last_status_at, last_ok)  # 다음 실행이 공백을 보고 다시 맞춘다
        self.assertIn('504', status.last_error)

        # 장애가 1시간을 넘기면 실패로 끝내 알린다
        PollerStatus.objects.filter(key='charger').update(last_status_at=timezone.now() - timedelta(hours=2))
        with mock.patch.object(poller.ev_api, 'fetch_rest_area_chargers', side_effect=err), \
             mock.patch.object(poller.ev_api, 'fetch_status_changes', side_effect=err):
            with self.assertRaises(CommandError):
                poller.run_cycle('KEY', StringIO())

    def test_full_baseline_once_a_day(self):
        self.run_poll(baseline_items=[item('ST1', '01', '2')])
        PollerStatus.objects.filter(key='charger').update(
            last_baseline_at=timezone.now() - timedelta(hours=25),
        )
        station = self.run_poll(baseline_items=[item('ST1', '01', '2')])
        station.assert_called_once_with('KEY', 'ST2')

    def test_cleared_congestion_notifies_and_closes_subscription(self):
        self.run_poll(baseline_items=[item('ST1', '01', '3'), item('ST1', '02', '3')])
        self.assertEqual(StationCongestion.objects.get(ra_node=self.ra_down).level, 'jammed')

        sub = CongestionNotifySubscription.objects.create(user_key='ait:abc', ra_node=self.ra_down)
        web = CongestionNotifySubscription.objects.create(user_key='anon_xyz', ra_node=self.ra_down)
        old = CongestionNotifySubscription.objects.create(
            user_key='ait:old', ra_node=self.ra_far,
            subscribed_at=timezone.now() - timedelta(hours=7),
        )

        with mock.patch.object(poller.toss_notify, 'send_congestion_cleared_message',
                               return_value=True) as send:
            self.run_poll(status_items=[
                item('ST1', '01', '2', '20261003121000'), item('ST1', '02', '2', '20261003121000'),
            ])
        self.assertEqual(StationCongestion.objects.get(ra_node=self.ra_down).level, 'smooth')
        sent_to = sorted(call.args[0] for call in send.call_args_list)
        self.assertEqual(sent_to, ['ait:abc', 'anon_xyz'])  # 발송 가능 여부는 toss_notify가 판단

        for s in (sub, web, old):
            s.refresh_from_db()
            self.assertFalse(s.is_active)
        self.assertIsNotNone(sub.notified_at)
        self.assertIsNone(old.notified_at)  # 만료로 종료


class ApiTests(Fixture):
    def setUp(self):
        super().setUp()
        self.client = APIClient()

    def test_congestion_endpoint_and_staleness(self):
        res = self.client.get(f'/api/v1/nodes/{self.ra_down.id}/congestion/')
        self.assertEqual(res.json()['level'], 'unknown')

        self.run_poll(baseline_items=[item('ST1', '01', '2'), item('ST1', '02', '4')])
        data = self.client.get(f'/api/v1/nodes/{self.ra_down.id}/congestion/').json()
        self.assertEqual((data['level'], data['available'], data['offline']), ('smooth', 1, 1))

        StationCongestion.objects.filter(ra_node=self.ra_down).update(
            updated_at=timezone.now() - timedelta(hours=1),
        )
        data = self.client.get(f'/api/v1/nodes/{self.ra_down.id}/congestion/').json()
        self.assertEqual(data['level'], 'unknown')
        self.assertIsNone(data['available'])

    def test_node_list_includes_congestion_for_rest_areas(self):
        res = self.client.get('/api/v1/highways/gyeongbu/nodes/?direction=DOWN&type=RA')
        nodes = res.json()['nodes']
        self.assertEqual(len(nodes), 2)
        self.assertIn('congestion', nodes[0])

    def test_nearest_includes_congestion(self):
        res = self.client.get('/api/v1/nodes/nearest-ra/?lat=37.2&lng=127.1&limit=2')
        stations = res.json()['stations']
        self.assertEqual(stations[0]['name'], '기흥휴게소')
        self.assertIn('congestion', stations[0])

    def test_anon_key_header_identifies_user(self):
        res = self.client.post('/api/v1/me/routes/', {'ra_node_id': self.ra_down.id},
                               format='json', HTTP_X_ANON_KEY='hash123')
        self.assertEqual(res.status_code, 201)
        self.assertNotIn('cf_uid', res.cookies)
        self.assertTrue(UserRoute.objects.filter(user_key='ait:hash123').exists())

        res = self.client.get('/api/v1/me/routes/', HTTP_X_ANON_KEY='hash123')
        self.assertEqual(res.json()['recent'][0]['ra_node_id'], self.ra_down.id)

    def test_cookie_fallback_for_browser(self):
        res = self.client.post('/api/v1/me/routes/', {'ra_node_id': self.ra_down.id}, format='json')
        self.assertIn('cf_uid', res.cookies)

    def test_notify_subscribe_reports_deliverability(self):
        url = f'/api/v1/nodes/{self.ra_down.id}/notify-me/'
        self.assertTrue(self.client.post(url, HTTP_X_ANON_KEY='h').json()['deliverable'])
        self.assertTrue(self.client.get(url, HTTP_X_ANON_KEY='h').json()['subscribed'])
        self.assertFalse(self.client.post(url).json()['deliverable'])

        self.client.delete(url, HTTP_X_ANON_KEY='h')
        self.assertFalse(self.client.get(url, HTTP_X_ANON_KEY='h').json()['subscribed'])

    def test_bypass_rejects_ic_node(self):
        ic = HighwayNode.objects.create(
            highway=self.ra_down.highway, node_type='IC', direction='DOWN', sequence=1,
            name='신갈JC', latitude=37.1, longitude=127.0, distance_from_start_km=1,
        )
        self.assertEqual(self.client.get(f'/api/v1/nodes/{ic.id}/bypass-stations/').status_code, 400)
        data = self.client.get(f'/api/v1/nodes/{self.ra_down.id}/bypass-stations/').json()
        self.assertIn('congestion', data)


class CorsTests(TestCase):
    @override_settings(CORS_ALLOW_ALL_ORIGINS=False,
                       CORS_ALLOWED_ORIGINS=['https://chargeflow.apps.tossmini.com'])
    def test_preflight_allows_anon_key_header(self):
        res = self.client.options(
            '/api/v1/highways/',
            HTTP_ORIGIN='https://chargeflow.apps.tossmini.com',
            HTTP_ACCESS_CONTROL_REQUEST_METHOD='GET',
            HTTP_ACCESS_CONTROL_REQUEST_HEADERS='x-anon-key',
        )
        self.assertEqual(res['access-control-allow-origin'], 'https://chargeflow.apps.tossmini.com')
        self.assertIn('x-anon-key', res['access-control-allow-headers'])


class TossNotifyTests(TestCase):
    def test_recipient_header(self):
        from chargeflow.services.toss_notify import recipient_header
        self.assertEqual(recipient_header('ait:abc'), {'x-anon-key': 'abc'})
        self.assertEqual(recipient_header('tsu:123'), {'x-toss-user-key': '123'})
        self.assertIsNone(recipient_header('anon_xyz'))


class ImprovementTests(Fixture):
    """우회 실시간·대기 판단·커넥터 설정·진행 방향·패턴 예측·여행 모드·즐겨찾기 알림"""

    def setUp(self):
        super().setUp()
        from chargeflow.models import ChargingStation, NodeStationMapping
        self.client = APIClient()
        hw = self.ra_down.highway
        # 하행: 1 IC(37.3) → 2 기흥 RA(37.2) → 3 망향 RA(36.8) → 4 IC(36.7)
        self.ic_prev = HighwayNode.objects.create(
            highway=hw, node_type='IC', direction='DOWN', sequence=1, name='수원IC',
            latitude=37.3, longitude=127.1, distance_from_start_km=0,
        )
        self.ic_next = HighwayNode.objects.create(
            highway=hw, node_type='IC', direction='DOWN', sequence=4, name='천안IC',
            latitude=36.7, longitude=127.2, distance_from_start_km=70,
        )
        HighwayNode.objects.filter(pk=self.ra_down.pk).update(prev_ic=self.ic_prev, next_ic=self.ic_next,
                                                             distance_from_start_km=10)
        HighwayNode.objects.filter(pk=self.ra_far.pk).update(distance_from_start_km=60)
        station = ChargingStation.objects.create(
            name='수원 마트', latitude=37.31, longitude=127.11, source_api_id='BY1', connectors='combo',
        )
        NodeStationMapping.objects.create(ic_node=self.ic_prev, station=station, distance_km=2.0,
                                          drive_minutes=5)

    def test_bypass_includes_station_realtime_and_detour(self):
        self.run_poll(baseline_items=[item('ST1', '01', '3')],
                      status_items=[item('BY1', '01', '2', '20200101120000')])  # 오래된 보고
        data = self.client.get(f'/api/v1/nodes/{self.ra_down.id}/bypass-stations/').json()
        st = data['previous_ic']['stations'][0]
        self.assertEqual(st['connectors'], ['combo'])
        self.assertEqual(st['detour_extra_minutes'], 2 * 5 + 4)
        # statUpdDt가 12시간보다 오래되면 실시간 정보로 쓰지 않는다
        self.assertIsNone(st['realtime'])

        from chargeflow.models import ChargerState
        ChargerState.objects.filter(stat_id='BY1').update(stat_updated_at=timezone.now())
        st = self.client.get(f'/api/v1/nodes/{self.ra_down.id}/bypass-stations/').json()['previous_ic']['stations'][0]
        self.assertEqual((st['realtime']['available'], st['realtime']['total']), (1, 1))

    def test_wait_estimate_uses_charging_start(self):
        started = (timezone.now() - timedelta(minutes=30)).astimezone(poller.ev_api.KST)
        self.run_poll(baseline_items=[
            dict(item('ST1', '01', '3'), nowTsdt=started.strftime('%Y%m%d%H%M%S')),
            item('ST1', '02', '3'),
        ])
        decision = self.client.get(f'/api/v1/nodes/{self.ra_down.id}/bypass-stations/').json()['decision']
        self.assertEqual(decision['wait_minutes'], 10)  # 40분 제한 - 30분 경과

    def test_wait_estimate_ignores_stale_sessions(self):
        started = (timezone.now() - timedelta(hours=3)).astimezone(poller.ev_api.KST)
        self.run_poll(baseline_items=[dict(item('ST1', '01', '3'), nowTsdt=started.strftime('%Y%m%d%H%M%S'))])
        decision = self.client.get(f'/api/v1/nodes/{self.ra_down.id}/bypass-stations/').json()['decision']
        self.assertIsNone(decision['wait_minutes'])

    def test_samples_and_prediction(self):
        from chargeflow.models import CongestionSample
        for _ in range(4):
            self.run_poll(baseline_items=[item('ST1', '01', '3')], force_baseline=True)
        self.assertEqual(CongestionSample.objects.get(ra_node=self.ra_down).samples, 4)
        data = self.client.get(f'/api/v1/nodes/{self.ra_down.id}/pattern/').json()
        self.assertEqual(len(data['hours']), 24)
        self.assertEqual(data['prediction'][0]['probability'], 100)  # 지금 만석 + (같은 시간대 패턴 없음)

    def test_nearest_filters_by_heading(self):
        # 남쪽(180°)으로 달리는 중: 하행(서울→남쪽) 휴게소 중 앞쪽만
        res = self.client.get('/api/v1/nodes/nearest-ra/?lat=37.25&lng=127.1&heading=180').json()
        self.assertTrue(res['direction_matched'])
        self.assertEqual([s['id'] for s in res['stations']], [self.ra_down.id, self.ra_far.id])

    def test_trip_lists_rest_areas_between(self):
        url = (f'/api/v1/highways/gyeongbu/trip/?direction=DOWN'
               f'&from={self.ic_prev.id}&to={self.ic_next.id}')
        data = self.client.get(url).json()
        self.assertEqual([s['id'] for s in data['stops']], [self.ra_down.id, self.ra_far.id])
        self.assertEqual(data['stops'][1]['km_from_start'], 60)
        bad = self.client.get(f'/api/v1/highways/gyeongbu/trip/?direction=DOWN&from={self.ic_next.id}&to={self.ic_prev.id}')
        self.assertEqual(bad.status_code, 400)

    def test_settings_roundtrip(self):
        self.assertEqual(self.client.get('/api/v1/me/settings/', HTTP_X_ANON_KEY='h').json()['connector'], '')
        self.client.put('/api/v1/me/settings/', {'connector': 'combo'}, format='json', HTTP_X_ANON_KEY='h')
        self.assertEqual(self.client.get('/api/v1/me/settings/', HTTP_X_ANON_KEY='h').json()['connector'], 'combo')
        bad = self.client.put('/api/v1/me/settings/', {'connector': 'xx'}, format='json', HTTP_X_ANON_KEY='h')
        self.assertEqual(bad.status_code, 400)

    def test_favorite_notify_on_transition_with_throttle(self):
        res = self.client.post(f'/api/v1/me/routes/{self.ra_down.id}/notify/', HTTP_X_ANON_KEY='h').json()
        self.assertTrue(res['is_favorite'] and res['notify_enabled'] and res['deliverable'])

        self.run_poll(baseline_items=[item('ST1', '01', '2')])           # unknown → smooth: 알림 없음
        with mock.patch.object(poller.toss_notify, 'send_favorite_status_message', return_value=True) as send:
            self.run_poll(status_items=[item('ST1', '01', '3', '20261003121000')])  # → jammed
            self.run_poll(status_items=[item('ST1', '01', '2', '20261003122000')])  # → smooth (2시간 안이라 생략)
        # 만석이 된 순간 1회만 — 2시간 안에 다시 풀린 건 알리지 않는다
        self.assertEqual(send.call_count, 1)
        self.assertEqual(send.call_args.args[2], '만석')


class PublicStationModelTests(TestCase):
    def test_stat_id_is_unique(self):
        PublicStation.objects.create(stat_id='ME000001', name='A', latitude=37.25, longitude=127.07, power_kw=100, charger_count=2)
        with self.assertRaises(IntegrityError):
            PublicStation.objects.create(stat_id='ME000001', name='B', latitude=37.0, longitude=127.0, power_kw=50, charger_count=1)

    def test_charger_state_output_kw_defaults_to_null(self):
        row = ChargerState.objects.create(stat_id='ME000001', charger_id='01', stat='2')
        self.assertIsNone(row.output_kw)


NOW = datetime(2026, 11, 19, 12, 0, tzinfo=ev_api.KST)


def _item(**over):
    base = {
        'statId': 'ME000001', 'chgerId': '01', 'statNm': '영통 공영주차장', 'addr': '경기 수원시',
        'lat': '37.251', 'lng': '127.071', 'output': '100', 'chgerType': '04', 'stat': '2',
        'statUpdDt': '20261119120000', 'busiNm': '환경부', 'useTime': '24시간 이용가능',
        'kind': 'A0', 'kindDetail': 'A001', 'limitYn': 'N', 'delYn': 'N', 'zcode': '41',
    }
    base.update(over)
    return base


class PublicCatalogTests(TestCase):
    def test_is_public_fast_rules(self):
        self.assertTrue(is_public_fast(_item()))
        for over in ({'output': '7'}, {'output': ''}, {'limitYn': 'Y'}, {'kind': 'H0'}, {'delYn': 'Y'},
                     {'kindDetail': 'C001'}, {'statNm': '기흥휴게소(부산)'}, {'lat': '0'}, {'lat': 'abc'}):
            self.assertFalse(is_public_fast(_item(**over)), over)

    def test_sync_creates_station_and_fast_chargers_only(self):
        seen = sync_items([_item(chgerId='01', output='100'), _item(chgerId='02', output='200', chgerType='01'),
                           _item(chgerId='03', output='7', chgerType='02')], NOW)
        st = PublicStation.objects.get(stat_id='ME000001')
        self.assertEqual(seen, {'ME000001'})
        self.assertEqual((st.power_kw, st.charger_count, st.connectors, st.is_active), (200, 2, 'combo,chademo', True))
        self.assertEqual(set(ChargerState.objects.values_list('charger_id', 'output_kw')), {('01', 100), ('02', 200)})

    def test_sync_fills_output_on_existing_slow_row_without_creating_new(self):
        ChargerState.objects.create(stat_id='ME000001', charger_id='03', stat='2')
        sync_items([_item(chgerId='01'), _item(chgerId='03', output='7')], NOW)
        self.assertEqual(ChargerState.objects.get(charger_id='03').output_kw, 7)
        self.assertEqual(ChargerState.objects.count(), 2)

    def test_sync_is_idempotent_and_updates_status(self):
        sync_items([_item(stat='2')], NOW)
        sync_items([_item(stat='3', statUpdDt='20261119130000', nowTsdt='20261119125000')], NOW)
        self.assertEqual(PublicStation.objects.count(), 1)
        row = ChargerState.objects.get(charger_id='01')
        self.assertEqual(row.stat, '3')
        self.assertIsNotNone(row.charging_since)

    def test_unknown_stat_becomes_9(self):
        sync_items([_item(stat='0')], NOW)
        self.assertEqual(ChargerState.objects.get(charger_id='01').stat, '9')

    def test_deactivate_missing(self):
        sync_items([_item(), _item(statId='ME000002')], NOW)
        self.assertEqual(deactivate_missing({'ME000001'}), 1)
        self.assertFalse(PublicStation.objects.get(stat_id='ME000002').is_active)

    def test_deactivate_missing_handles_many_stations_in_chunks(self):
        PublicStation.objects.bulk_create([
            PublicStation(stat_id=f'BULK{i:05d}', name='n', latitude=37.0, longitude=127.0,
                          power_kw=50, charger_count=1)
            for i in range(1200)])
        keep = {f'BULK{i:05d}' for i in range(100)}
        self.assertEqual(deactivate_missing(keep), 1100)
        self.assertEqual(PublicStation.objects.filter(is_active=True).count(), 100)


def fmt(dt):
    return dt.astimezone(ev_api.KST).strftime('%Y%m%d%H%M%S')


class ZcodeConstantTests(TestCase):
    def test_public_zcodes_include_jeju_and_zcodes_unchanged(self):
        self.assertIn('50', ev_api.PUBLIC_ZCODES)
        self.assertEqual(len(ev_api.ZCODES), 17)
        self.assertNotIn('50', ev_api.ZCODES)


@mock.patch.object(ev_api, 'PUBLIC_ZCODES', ['41', '11'])
@mock.patch.object(ev_api, 'fetch_region_chargers')
class SyncPublicStationsTests(TestCase):
    def setUp(self):
        patcher = mock.patch('chargeflow.management.commands.sync_public_stations.time.sleep')
        self.sleep = patcher.start()
        self.addCleanup(patcher.stop)

    def _old(self):
        PublicStation.objects.create(stat_id='OLD00001', name='옛 충전소', latitude=37.0, longitude=127.0,
                                     power_kw=50, charger_count=1)

    def test_full_scan_deactivates_missing(self, fetch):
        self._old()
        fetch.side_effect = lambda key, z, **kw: [_item(zcode=z, statId=f'ME0000{z}')]
        call_command('sync_public_stations', api_key='k', stdout=StringIO())
        self.assertFalse(PublicStation.objects.get(stat_id='OLD00001').is_active)
        self.assertEqual(PublicStation.objects.filter(is_active=True).count(), 2)

    def test_failed_region_does_not_deactivate(self, fetch):
        self._old()

        def flaky(key, z, **kw):
            if z == '11':
                raise ev_api.EvApiError('504')
            return [_item(zcode=z)]
        fetch.side_effect = flaky
        with self.assertRaises(CommandError) as cm:
            call_command('sync_public_stations', api_key='k', stdout=StringIO())
        self.assertIn('11', str(cm.exception))
        self.assertTrue(PublicStation.objects.get(stat_id='OLD00001').is_active)
        self.assertTrue(PublicStation.objects.filter(stat_id='ME000001').exists())

    def test_always_failing_region_still_applies_others(self, fetch):
        self._old()

        def flaky(key, z, **kw):
            if z == '41':
                raise ev_api.EvApiError('504')
            return [_item(zcode=z, statId='ME000011')]
        fetch.side_effect = flaky
        with self.assertRaises(CommandError) as cm:
            call_command('sync_public_stations', api_key='k', stdout=StringIO())
        self.assertIn('41', str(cm.exception))
        self.assertTrue(PublicStation.objects.filter(stat_id='ME000011').exists())
        self.assertTrue(PublicStation.objects.get(stat_id='OLD00001').is_active)
        self.assertEqual(self.sleep.call_count, 2)  # 41 지역만 3회 시도 -> 대기 2번

    def test_region_failing_once_is_retried(self, fetch):
        self._old()
        calls = {'41': 0}

        def flaky(key, z, **kw):
            if z == '41':
                calls['41'] += 1
                if calls['41'] == 1:
                    raise ev_api.EvApiError('504')
            return [_item(zcode=z, statId=f'ME0000{z}')]
        fetch.side_effect = flaky
        call_command('sync_public_stations', api_key='k', stdout=StringIO())
        self.assertEqual(self.sleep.call_count, 1)
        self.assertFalse(PublicStation.objects.get(stat_id='OLD00001').is_active)

    def test_guard_blocks_deactivation_on_tiny_scan(self, fetch):
        PublicStation.objects.bulk_create([
            PublicStation(stat_id=f'G{i:05d}', name='n', latitude=37.0, longitude=127.0,
                          power_kw=50, charger_count=1) for i in range(200)])
        fetch.side_effect = lambda key, z, **kw: [_item(zcode=z)] if z == '41' else []
        out = StringIO()
        with self.assertRaises(CommandError):
            call_command('sync_public_stations', api_key='k', stdout=out)
        self.assertEqual(PublicStation.objects.filter(is_active=True, stat_id__startswith='G').count(), 200)
        self.assertIn('안전장치', out.getvalue())

    def test_partial_zcodes_never_deactivate(self, fetch):
        self._old()
        fetch.side_effect = lambda key, z, **kw: [_item(zcode=z)]
        call_command('sync_public_stations', api_key='k', zcodes=['41'], stdout=StringIO())
        self.assertTrue(PublicStation.objects.get(stat_id='OLD00001').is_active)

    def test_report_only_does_not_call_api(self, fetch):
        out = StringIO()
        call_command('sync_public_stations', report_only=True, stdout=out)
        fetch.assert_not_called()
        self.assertIn('stations', out.getvalue())

    def test_freshness_report_ratios(self, fetch):
        sync_items([_item(chgerId='01', statUpdDt=fmt(NOW - timedelta(minutes=10))),
                    _item(chgerId='02', statUpdDt=fmt(NOW - timedelta(hours=1))),
                    _item(chgerId='03', statUpdDt=fmt(NOW - timedelta(hours=5))),
                    _item(chgerId='04', statUpdDt=fmt(NOW - timedelta(hours=20)))], NOW)
        r = freshness_report(NOW)
        self.assertEqual((r['stations'], r['chargers']), (1, 4))
        self.assertEqual((r['within_30m'], r['within_2h'], r['within_12h']), (0.25, 0.5, 0.75))

    def test_freshness_report_empty(self, fetch):
        r = freshness_report(NOW)
        self.assertEqual((r['stations'], r['chargers'], r['within_2h']), (0, 0, 0.0))


def _station(stat_id, lat, lng, chargers, connectors='combo'):
    """chargers: (stat, age_minutes, output_kw) 목록."""
    st = PublicStation.objects.create(
        stat_id=stat_id, name=f'충전소 {stat_id}', address='주소', latitude=lat, longitude=lng,
        connectors=connectors, power_kw=100, charger_count=len(chargers),
    )
    for i, (stat, age, kw) in enumerate(chargers):
        ChargerState.objects.create(
            stat_id=stat_id, charger_id=f'{i:02}', stat=stat,
            stat_updated_at=NOW - timedelta(minutes=age), output_kw=kw,
        )
    return st


class NearbyServiceTests(TestCase):
    def test_status_counts_and_states(self):
        fresh = NOW - timedelta(minutes=5)
        self.assertEqual(station_status([('2', fresh), ('3', fresh), ('5', fresh)], NOW)['state'], 'available')
        s = station_status([('3', fresh), ('1', fresh)], NOW)
        self.assertEqual((s['available'], s['charging'], s['offline'], s['total'], s['state']), (0, 1, 1, 2, 'full'))
        self.assertEqual(station_status([('4', fresh), ('5', fresh)], NOW)['state'], 'unavailable')

    def test_stale_available_is_not_counted(self):
        fresh, old = NOW - timedelta(minutes=5), NOW - PUBLIC_STALE - timedelta(minutes=1)
        s = station_status([('2', old), ('3', fresh)], NOW)
        self.assertEqual((s['available'], s['state']), (0, 'full'))
        self.assertIsNone(station_status([('2', old), ('2', None)], NOW))
        self.assertIsNone(station_status([], NOW))

    def test_only_fast_chargers_are_counted(self):
        _station('A', 37.2590, 127.07, [('3', 5, 100), ('2', 5, 7), ('2', 5, None)])
        st = search_nearby(37.25, 127.07, now=NOW)['stations'][0]
        self.assertEqual((st['available'], st['total'], st['state']), (0, 1, 'full'))

    def test_radius_stops_at_first_with_three_available(self):
        for i, km in enumerate((1, 2, 3)):
            _station(f'N{i}', 37.25 + 0.009 * km, 127.07, [('2', 5, 100)])
        _station('FAR', 37.25 + 0.009 * 8, 127.07, [('2', 5, 100)])
        r = search_nearby(37.25, 127.07, now=NOW)
        self.assertEqual(r['radius_km'], 5)
        self.assertEqual([s['stat_id'] for s in r['stations']], ['N0', 'N1', 'N2'])

    def test_radius_expands_when_not_enough(self):
        _station('N0', 37.25 + 0.009 * 1, 127.07, [('2', 5, 100)])
        _station('MID', 37.25 + 0.009 * 8, 127.07, [('2', 5, 100)])
        _station('FAR', 37.25 + 0.009 * 15, 127.07, [('2', 5, 100)])
        self.assertEqual(search_nearby(37.25, 127.07, now=NOW)['radius_km'], 20)

    def test_falls_back_to_30km_with_full_stations(self):
        _station('FULL', 37.25 + 0.009 * 12, 127.07, [('3', 5, 100)])
        r = search_nearby(37.25, 127.07, now=NOW)
        self.assertEqual((r['radius_km'], r['stations'][0]['state']), (30, 'full'))

    def test_excludes_inactive_unknown_and_beyond_30km(self):
        _station('OFF', 37.259, 127.07, [('2', 5, 100)])
        PublicStation.objects.filter(stat_id='OFF').update(is_active=False)
        _station('UNK', 37.259, 127.07, [('9', 5, 100)])
        _station('OUT', 37.25 + 0.009 * 40, 127.07, [('2', 5, 100)])
        self.assertEqual(search_nearby(37.25, 127.07, now=NOW)['stations'], [])

    def test_connector_filter_keeps_matching_and_unknown(self):
        _station('C', 37.259, 127.07, [('2', 5, 100)], connectors='combo')
        _station('D', 37.260, 127.07, [('2', 5, 100)], connectors='chademo')
        _station('E', 37.261, 127.07, [('2', 5, 100)], connectors='')
        ids = [s['stat_id'] for s in search_nearby(37.25, 127.07, connector='combo', now=NOW)['stations']]
        self.assertEqual(ids, ['C', 'E'])

    def test_result_cap_keeps_available_first(self):
        for i in range(25):
            _station(f'F{i:02}', 37.25 + 0.0005 * (i + 1), 127.07, [('3', 5, 100)])
        for i in range(22):
            _station(f'A{i:02}', 37.25 + 0.02 + 0.0005 * i, 127.07, [('2', 5, 100)])
        st = search_nearby(37.25, 127.07, now=NOW)['stations']
        self.assertEqual(len(st), 30)
        self.assertEqual(sum(s['state'] == 'available' for s in st), 20)
        self.assertEqual(st, sorted(st, key=lambda s: s['distance_km']))

    def test_in_korea(self):
        self.assertTrue(in_korea(37.5, 127.0))
        self.assertTrue(in_korea(33.4, 126.5))
        for lat, lng in ((0, 0), (35.6, 139.7), (40.0, 127.0)):
            self.assertFalse(in_korea(lat, lng))


@mock.patch('django.utils.timezone.now', return_value=NOW)  # 서비스가 읽는 현재 시각을 NOW로 고정
class NearbyApiTests(TestCase):
    URL = '/api/v1/stations/nearby/'

    def setUp(self):
        self.client = APIClient()

    def test_returns_nearby_stations(self, _now):
        _station('A', 37.259, 127.07, [('2', 5, 100)])
        res = self.client.post(self.URL, {'lat': 37.25, 'lng': 127.07}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(set(res.data), {'radius_km', 'fetched_at', 'stations'})
        self.assertEqual(res.data['stations'][0]['stat_id'], 'A')

    def test_rejects_bad_coordinates(self, _now):
        for body in ({}, {'lat': 37.25}, {'lat': 'abc', 'lng': 127.07}, {'lat': 0, 'lng': 0},
                     {'lat': 35.6, 'lng': 139.7}, {'lat': True, 'lng': 127.07}, {'lat': None, 'lng': 127.07}):
            res = self.client.post(self.URL, body, format='json')
            self.assertEqual(res.status_code, 400, body)
            self.assertEqual(res.data, {'detail': '위치를 확인하지 못했어요.'})
        res = self.client.post(self.URL, data='[1, 2]', content_type='application/json')
        self.assertEqual(res.status_code, 400)
        res = self.client.post(self.URL, data='{"lat": 1e999, "lng": 127.07}', content_type='application/json')
        self.assertEqual(res.status_code, 400)

    def test_rejects_huge_integer_coordinates(self, _now):
        huge = '1' + '0' * 400
        for raw in ('{"lat": %s, "lng": 127.07}' % huge, '{"lat": 37.25, "lng": %s}' % huge):
            res = self.client.post(self.URL, data=raw, content_type='application/json')
            self.assertEqual(res.status_code, 400, raw[:30])
            self.assertEqual(res.data, {'detail': '위치를 확인하지 못했어요.'})

    def test_valid_connector_filters(self, _now):
        _station('C', 37.259, 127.07, [('2', 5, 100)], connectors='combo')
        _station('D', 37.260, 127.07, [('2', 5, 100)], connectors='chademo')
        res = self.client.post(self.URL, {'lat': 37.25, 'lng': 127.07, 'connector': 'chademo'}, format='json')
        self.assertEqual([s['stat_id'] for s in res.data['stations']], ['D'])

    def test_unknown_connector_is_ignored(self, _now):
        _station('A', 37.259, 127.07, [('2', 5, 100)], connectors='chademo')
        res = self.client.post(self.URL, {'lat': 37.25, 'lng': 127.07, 'connector': 'zzz'}, format='json')
        self.assertEqual(len(res.data['stations']), 1)

    def test_get_is_not_allowed(self, _now):
        self.assertEqual(self.client.get(self.URL + '?lat=37.25&lng=127.07').status_code, 405)

    def test_station_detail_route_still_works(self, _now):
        self.assertEqual(self.client.get('/api/v1/stations/999999/').status_code, 404)
