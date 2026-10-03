import { defineConfig } from '@apps-in-toss/web-framework/config';

export default defineConfig({
  appName: 'chargeflow',
  brand: {
    primaryColor: '#3182F6',
  },
  // "가는 길 휴게소 찾기"에서 현재 위치·진행 방향을 잴 때만 요청한다
  permissions: [{ name: 'geolocation', access: 'access' }],
  navigationBar: {
    withBackButton: true,
    withTitle: true,
    theme: 'light',
  },
  webView: {
    // 화면 안 지도는 드래그로 움직이므로 웹뷰 바운스·당겨서 새로고침은 끈다
    bounces: false,
    pullToRefreshEnabled: false,
  },
  webBundleDir: 'dist',
});
