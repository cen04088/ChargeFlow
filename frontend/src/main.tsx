import { TDSMobileAITProvider } from "@toss/tds-mobile-ait";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import config from "../apps-in-toss.config.ts";
import App from "./App.tsx";
import "./index.css";

// 디버그 빌드에서만 실기기 디버거를 붙인다(일반 빌드에서는 이 블록이 통째로 빠진다)
if (__DEBUG_BUILD__) {
  import("@apps-in-toss/debugger-client").then((m) =>
    m.startDebugConsole({ relayPublicKeys: __AIT_RELAY_KEYS__ }),
  );
}

// iOS WebView는 터치 리스너가 없으면 :active를 늦게 적용한다 — 누르는 즉시 반응하도록 등록
document.addEventListener("touchstart", () => {}, { passive: true });

// 안드로이드 토스 웹뷰는 아래 safe area를 이중으로 알려 준다 — CSS가 고정 여백을 쓰게 표시한다
if (/Android/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("is-android");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TDSMobileAITProvider brandPrimaryColor={config.brand.primaryColor}>
      <App />
    </TDSMobileAITProvider>
  </StrictMode>,
);
