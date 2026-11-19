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
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    loadHighways().then(
      (data) => alive && setState({ data }),
      (error: Error) => alive && setState({ error }),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);
  return {
    ...state,
    reload: () => {
      setState({});
      setAttempt((value) => value + 1);
    },
  };
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

// ── 최소 충전 출력(이 기기에만 저장) ─────────────────
export type MinPower = 0 | 100 | 200;

export const MIN_POWER_OPTIONS: { value: MinPower; label: string }[] = [
  { value: 0, label: "전체" },
  { value: 100, label: "100kW 이상" },
  { value: 200, label: "200kW 이상 초급속" },
];

const MIN_POWER_KEY = "nearby:minKw";

/** 저장된 값을 읽는다. 없거나 깨졌으면 0(전체) */
export function parseMinPower(raw: string | null): MinPower {
  return raw === "100" ? 100 : raw === "200" ? 200 : 0;
}

function readMinPower(): MinPower {
  try {
    return parseMinPower(localStorage.getItem(MIN_POWER_KEY));
  } catch {
    return 0;
  }
}

let minPower: MinPower = readMinPower();
const minPowerListeners = new Set<() => void>();

export function useMinPower(): [MinPower, (v: MinPower) => void] {
  const value = useSyncExternalStore(
    (l) => {
      minPowerListeners.add(l);
      return () => minPowerListeners.delete(l);
    },
    () => minPower,
  );
  const save = (next: MinPower) => {
    minPower = next;
    try {
      localStorage.setItem(MIN_POWER_KEY, String(next));
    } catch {
      // 저장 실패는 무시 — 이번 화면에서는 그대로 쓴다
    }
    minPowerListeners.forEach((l) => l());
  };
  return [value, save];
}
