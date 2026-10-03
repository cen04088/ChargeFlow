import { api } from "../api/client";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    kakao?: any;
  }
}

let loader: Promise<any> | null = null;

/** 카카오맵 JS SDK를 필요할 때 한 번만 불러온다. 실패하면 null. */
export function loadKakaoMaps(): Promise<any | null> {
  if (!loader) {
    loader = (async () => {
      if (window.kakao?.maps) return window.kakao;
      const key = await api.kakaoKey();
      if (!key) return null;
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${key}&autoload=false`;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("kakao sdk load failed"));
        document.head.appendChild(script);
      });
      await new Promise<void>((resolve) => window.kakao.maps.load(resolve));
      return window.kakao;
    })().catch(() => {
      loader = null; // 다음 진입 때 다시 시도
      return null;
    });
  }
  return loader;
}
