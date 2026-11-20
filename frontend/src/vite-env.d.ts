/// <reference types="vite/client" />

declare module "*.css" {
  const content: Record<string, string>;
  export default content;
}

/** AIT_DEBUG_BUILD=1로 만든 디버그 빌드인지(vite.config의 define) */
declare const __DEBUG_BUILD__: boolean;
/** 디버그 빌드에 넣은 디버거 서명 공개키 */
declare const __AIT_RELAY_KEYS__: ReadonlyArray<{ publicKey: string; notAfter: number }>;

interface ImportMetaEnv {
  /** Django API 주소 (기본: 운영 Railway) */
  readonly VITE_API_BASE_URL?: string;
  /** 콘솔 스마트발송 템플릿 코드 — 있으면 빈자리 알림 신청 전 알림 동의를 받는다 */
  readonly VITE_NOTIFY_TEMPLATE_CODE?: string;
}
