from datetime import timedelta
from io import StringIO
from unittest import mock

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from chargeflow.management.commands import poll_charger_status as poller
from chargeflow.models import (
    ChargerState, ChargerStatusLog, CongestionNotifySubscription, Highway, HighwayNode,
    HighwayNodeCharger, PollerStatus, StationCongestion, UserRoute,
)
from chargeflow.services.congestion import compute_level, recompute_all


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

    def test_gap_triggers_baseline(self):
        self.run_poll(baseline_items=[item('ST1', '01', '2')])
        PollerStatus.objects.filter(key='charger').update(
            last_status_at=timezone.now() - timedelta(minutes=30),
        )
        self.run_poll(baseline_items=[item('ST1', '01', '3', '20261003130000')])
        self.assertEqual(ChargerState.objects.get(stat_id='ST1', charger_id='01').stat, '3')

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
