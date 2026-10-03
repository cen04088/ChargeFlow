/// <reference types="vite/client" />

declare module "*.css" {
  const content: Record<string, string>;
  export default content;
}

interface ImportMetaEnv {
  /** Django API 주소 (기본: 운영 Railway) */
  readonly VITE_API_BASE_URL?: string;
  /** 콘솔 스마트발송 템플릿 코드 — 있으면 빈자리 알림 신청 전 알림 동의를 받는다 */
  readonly VITE_NOTIFY_TEMPLATE_CODE?: string;
}
