/**
 * 화면 사이에서 공유하는 작은 상태: 노선 목록(앱 실행 중 1회 조회)과 내 차 커넥터 설정.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import { api } from "../api/client";
import type { Connector, Highway } from "../api/types";

// ── 노선 목록 ──────────────────────────────────
let highwaysPromise: Promise<Highway[]> | null = null;

export function loadHighways() {
  if (!highwaysPromise) {
    highwaysPromise = api.highways().catch((e) => {
      highwaysPromise = null; // 다음에 다시 시도
      throw e;
    });
  }
  return highwaysPromise;
}

export function useHighways() {
  const [state, setState] = useState<{ data?: Highway[]; error?: Error }>({});
  useEffect(() => {
    let alive = true;
    loadHighways().then(
      (data) => alive && setState({ data }),
      (error: Error) => alive && setState({ error }),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

// ── 내 차 커넥터 ───────────────────────────────
let connector: Connector = "";
let connectorLoaded = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function useConnector(): [Connector, (c: Connector) => Promise<void>] {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => connector,
  );

  useEffect(() => {
    if (connectorLoaded) return;
    connectorLoaded = true;
    api.settings().then(
      (res) => {
        connector = res.connector;
        emit();
      },
      () => {
        connectorLoaded = false;
      },
    );
  }, []);

  const save = async (next: Connector) => {
    const prev = connector;
    connector = next;
    emit();
    try {
      await api.saveSettings(next);
    } catch (e) {
      connector = prev;
      emit();
      throw e;
    }
  };
  return [value, save];
}

export const CONNECTOR_OPTIONS: { value: Connector; label: string }[] = [
  { value: "", label: "전체" },
  { value: "combo", label: "DC콤보" },
  { value: "chademo", label: "DC차데모" },
  { value: "ac3", label: "AC3상" },
  { value: "nacs", label: "NACS" },
];

export function connectorName(c: Connector | string) {
  return CONNECTOR_OPTIONS.find((o) => o.value === c)?.label ?? c;
}
