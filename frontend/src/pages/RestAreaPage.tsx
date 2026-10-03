import { Notification } from "@apps-in-toss/web-framework";
import {
  Border,
  Button,
  ListHeader,
  Paragraph,
  Skeleton,
  Spacing,
  Tab,
  TextButton,
  Top,
  useToast,
} from "@toss/tds-mobile";
import { adaptive } from "@toss/tds-colors";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useParams } from "react-router-dom";

import { api } from "../api/client";
import type {
  BypassIC,
  BypassResponse,
  BypassStation,
  Connector,
  Forecast,
  NotifySubscription,
} from "../api/types";
import { SectionHeader } from "../components/SectionHeader";
import { ErrorState } from "../components/ErrorState";
import { PatternChart } from "../components/PatternChart";
import { RestAreaMap } from "../components/RestAreaMap";
import { StationRow } from "../components/StationRow";
import {
  LEVEL_TEXT_COLOR,
  availabilityText,
  directionLabel,
  formatMinutes,
  needsBypass,
  shortName,
  timeAgo,
  weekdayName,
} from "../lib/format";
import { connectorName, useConnector, useHighways } from "../lib/store";
import { logClick, logScreen, shareRestArea } from "../lib/toss";
import { useAsync } from "../lib/useAsync";

const REFRESH_MS = 60_000;
const NOTIFY_TEMPLATE = import.meta.env.VITE_NOTIFY_TEMPLATE_CODE as
  string | undefined;

type Which = "prev" | "next";

export default function RestAreaPage() {
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const [maxMinutes, setMaxMinutes] = useState(15);
  const bypass = useAsync(
    () =>
      valid ? api.bypass(id, maxMinutes) : Promise.reject(new Error("invalid")),
    [id, maxMinutes],
  );

  useEffect(() => {
    if (!valid) return;
    logScreen("rest_area", { rest_area_id: id });
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") bypass.reload();
    }, REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, valid]);

  if (!valid) return <Navigate to="/" replace />;
  if (bypass.error && !bypass.data) {
    return (
      <ErrorState error={bypass.error} onRetry={bypass.reload} />
    );
  }
  if (!bypass.data)
    return <Skeleton pattern="topList" repeatLastItemCount={4} />;

  return (
    <RestAreaView
      key={id}
      data={bypass.data}
      maxMinutes={maxMinutes}
      onWiden={() => {
        logClick("rest_area_widen_range");
        setMaxMinutes(30);
      }}
    />
  );
}

/** 커넥터 설정에 맞는 충전소인지 (설정이 없거나 커넥터 정보가 없으면 보여준다) */
function fits(station: BypassStation, connector: Connector) {
  return (
    !connector ||
    station.connectors.length === 0 ||
    station.connectors.includes(connector)
  );
}

/** 가장 빨리 충전할 수 있는 우회 충전소: 빈 충전기가 확인된 곳 우선, 그다음 우회 시간 */
function bestDetour(stations: BypassStation[]) {
  const score = (s: BypassStation) =>
    (s.realtime ? (s.realtime.available > 0 ? 0 : 1000) : 100) +
    s.detour_extra_minutes;
  return [...stations].sort((a, b) => score(a) - score(b))[0];
}

function forecastText(f: Forecast) {
  return `${f.hours_ahead}시간 뒤 ${f.label}`;
}

function RestAreaView({
  data,
  maxMinutes,
  onWiden,
}: {
  data: BypassResponse;
  maxMinutes: number;
  onWiden: () => void;
}) {
  const ra = data.target_rest_area;
  const congestion = data.congestion;
  const { openToast } = useToast();
  const highways = useHighways().data;
  const [connector] = useConnector();
  const [favorite, setFavorite] = useState(false);
  const [favNotify, setFavNotify] = useState(false);
  const [notify, setNotify] = useState<NotifySubscription | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const pattern = useAsync(() => api.pattern(ra.id), [ra.id]);

  const ics = [data.previous_ic, data.next_ic].filter(Boolean) as BypassIC[];
  const [tab, setTab] = useState<Which>(data.previous_ic ? "prev" : "next");
  const activeIC = tab === "prev" ? data.previous_ic : data.next_ic;
  const filter = (list: BypassStation[]) =>
    showAll ? list : list.filter((s) => fits(s, connector));

  // 지도·판단에는 두 IC의 충전소를 함께, 중복 없이 쓴다
  const allStations = useMemo(() => {
    const seen = new Set<number>();
    return ics
      .flatMap((ic) => ic.stations)
      .filter((s) => !seen.has(s.id) && !!seen.add(s.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.previous_ic, data.next_ic]);
  const usable = allStations.filter((s) => fits(s, connector));
  const best = bestDetour(usable);

  useEffect(() => {
    api.recordVisit(ra.id).then(
      (r) => {
        setFavorite(r.is_favorite);
        setFavNotify(r.notify_enabled);
      },
      () => {},
    );
    api.notifyStatus(ra.id).then(setNotify, () => {});
  }, [ra.id]);

  const toggleFavorite = async () => {
    const next = !favorite;
    setFavorite(next);
    if (!next) setFavNotify(false);
    logClick("rest_area_favorite", { on: next ? 1 : 0 });
    try {
      await (next ? api.addFavorite(ra.id) : api.removeFavorite(ra.id));
      openToast(next ? "즐겨찾기에 추가했어요" : "즐겨찾기에서 뺐어요");
    } catch {
      setFavorite(!next);
      openToast("잠시 후 다시 시도해 주세요");
    }
  };

  const askAgreement = async () => {
    // 콘솔에 알림 템플릿이 등록돼 있으면 토스 알림 동의를 먼저 받는다
    if (!NOTIFY_TEMPLATE || !Notification.requestAgreement.isSupported())
      return true;
    return new Promise<boolean>((resolve) => {
      const cleanup = Notification.requestAgreement({
        options: { templateCode: NOTIFY_TEMPLATE },
        onEvent: ({ type }) => {
          cleanup();
          resolve(type !== "agreementRejected");
        },
        onError: () => {
          cleanup();
          resolve(false);
        },
      });
    });
  };

  const toggleFavoriteNotify = async () => {
    const next = !favNotify;
    logClick("rest_area_favorite_notify", { on: next ? 1 : 0 });
    if (next && !(await askAgreement())) {
      openToast("알림을 허용하면 상태가 바뀔 때 알려드릴 수 있어요");
      return;
    }
    setFavNotify(next);
    try {
      if (next) {
        const res = await api.enableFavoriteNotify(ra.id);
        setFavorite(true);
        openToast(
          res.deliverable
            ? "붐비거나 다시 여유로워지면 알려드릴게요"
            : "토스 앱에서 열면 알림을 받을 수 있어요",
        );
      } else {
        await api.disableFavoriteNotify(ra.id);
        openToast("상태 알림을 껐어요");
      }
    } catch {
      setFavNotify(!next);
      openToast("잠시 후 다시 시도해 주세요");
    }
  };

  const share = async () => {
    logClick("rest_area_share");
    try {
      await shareRestArea(ra.id, shortName(ra.name));
    } catch {
      openToast("공유하지 못했어요. 잠시 후 다시 시도해 주세요");
    }
  };

  const subscribe = async () => {
    logClick("rest_area_notify", { on: 1 });
    if (!(await askAgreement())) {
      openToast("알림을 허용하면 충전기가 빌 때 알려드릴 수 있어요");
      return;
    }
    try {
      const res = await api.subscribeNotify(ra.id);
      setNotify(res);
      openToast(
        res.deliverable === false
          ? "토스 앱에서 열면 알림을 받을 수 있어요"
          : "충전기가 비면 토스 알림으로 알려드릴게요",
      );
    } catch {
      openToast("잠시 후 다시 시도해 주세요");
    }
  };

  const unsubscribe = async () => {
    logClick("rest_area_notify", { on: 0 });
    try {
      await api.unsubscribeNotify(ra.id);
      setNotify({ subscribed: false });
      openToast("알림을 껐어요");
    } catch {
      openToast("잠시 후 다시 시도해 주세요");
    }
  };

  const waiting = needsBypass(congestion);
  const known = congestion.level !== "unknown";
  const wait = data.decision.wait_minutes;
  const forecasts = data.decision.prediction.filter((f) => f.label);
  const now = new Date();
  const icStations = activeIC?.stations ?? [];
  const visibleStations = filter(icStations);
  const hiddenCount =
    icStations.length - icStations.filter((s) => fits(s, connector)).length;

  return (
    <div className="page">
      <Top
        subtitleTop={
          <Top.SubtitleParagraph size={15}>
            {ra.highway_name} ·{" "}
            {directionLabel(highways, ra.highway_code, ra.direction)}
          </Top.SubtitleParagraph>
        }
        title={
          <Top.TitleParagraph size={22}>
            {shortName(ra.name)}
          </Top.TitleParagraph>
        }
        subtitleBottom={
          <Top.SubtitleParagraph size={17}>
            <span
              style={{
                color: LEVEL_TEXT_COLOR[congestion.level],
                fontWeight: 700,
              }}
            >
              {congestion.label}
            </span>
            {known && ` · ${availabilityText(congestion)}`}
          </Top.SubtitleParagraph>
        }
      />

      <div className="section-pad">
        <Paragraph typography="t6" color={adaptive.grey600}>
          {known
            ? `${timeAgo(congestion.checked_at)} · 1분마다 새로 확인해요`
            : "지금은 충전기 정보를 받아오지 못했어요. 아래 IC 밖 충전소는 그대로 이용할 수 있어요."}
        </Paragraph>
        {forecasts.length > 0 && (
          <Paragraph typography="t6" color={adaptive.grey700}>
            혼잡 예측 {forecasts.map(forecastText).join(" · ")}
            {forecasts.some((f) => f.based_on_history)
              ? " (평소 패턴 반영)"
              : " (지금 상태 기준)"}
          </Paragraph>
        )}
        <div className="actions">
          <TextButton
            size="medium"
            variant="clear"
            color={adaptive.grey700}
            onClick={toggleFavorite}
          >
            {favorite ? "즐겨찾기 해제" : "즐겨찾기"}
          </TextButton>
          <TextButton
            size="medium"
            variant="clear"
            color={adaptive.grey700}
            onClick={toggleFavoriteNotify}
          >
            {favNotify ? "상태 알림 끄기" : "상태 알림 받기"}
          </TextButton>
          <TextButton
            size="medium"
            variant="clear"
            color={adaptive.grey700}
            onClick={share}
          >
            공유하기
          </TextButton>
        </div>
      </div>

      {waiting && (
        <div className="section-pad">
          <div className="callout">
            <Paragraph typography="t5" fontWeight="bold">
              {congestion.level === "unavailable"
                ? "이 휴게소 충전기를 지금 쓸 수 없어요"
                : wait != null && wait <= 5
                  ? "곧 자리가 날 수 있지만 지금은 모두 사용 중이에요"
                  : wait != null
                    ? `도착하면 약 ${formatMinutes(wait)} 기다려야 해요`
                    : "도착하면 기다려야 할 수 있어요"}
            </Paragraph>
            <Paragraph typography="t6" color={adaptive.grey700}>
              {best
                ? `우회 추천 ${best.name} · ${best.is_estimated ? "약 " : ""}${best.detour_extra_minutes}분 더 걸려요` +
                  (best.realtime
                    ? ` · 빈 충전기 ${best.realtime.available}/${best.realtime.total}`
                    : "") +
                  (wait != null && congestion.level !== "unavailable"
                    ? best.detour_extra_minutes < wait
                      ? " — 우회하는 편이 빨라요."
                      : " — 기다리는 편이 빨라요."
                    : "")
                : "IC로 잠깐 나가면 기다리지 않고 충전할 수 있는 곳이 있는지 아래에서 확인해 보세요."}
            </Paragraph>
            <Spacing size={12} />
            {notify?.subscribed ? (
              <Button
                display="full"
                size="medium"
                variant="weak"
                color="dark"
                onClick={unsubscribe}
              >
                빈자리 알림 끄기
              </Button>
            ) : (
              <Button
                display="full"
                size="medium"
                variant="weak"
                onClick={subscribe}
              >
                충전기가 비면 알림 받기
              </Button>
            )}
          </div>
        </div>
      )}

      <Border variant="height16" />

      <SectionHeader
        title="IC 밖 대체 충전소"
        description={`고속도로를 나가 ${maxMinutes}분 안에 갈 수 있는 곳이에요${connector ? ` · ${connectorName(connector)}` : ""}`}
      />

      {ics.length > 0 && (
        <RestAreaMap
          restArea={{
            lat: +ra.latitude,
            lng: +ra.longitude,
            name: shortName(ra.name),
          }}
          ics={ics}
          stations={showAll ? allStations : usable}
          focusId={focusId}
          onSelectStation={(sid) => {
            const inPrev = data.previous_ic?.stations.some((s) => s.id === sid);
            setTab(inPrev ? "prev" : "next");
            setFocusId(sid);
            document
              .getElementById(`station-${sid}`)
              ?.scrollIntoView({ behavior: "smooth", block: "center" });
          }}
        />
      )}

      {ics.length > 1 && (
        <Tab onChange={(i) => setTab(i === 0 ? "prev" : "next")} fluid>
          <Tab.Item selected={tab === "prev"}>휴게소 전에 나가기</Tab.Item>
          <Tab.Item selected={tab === "next"}>휴게소 지나서 나가기</Tab.Item>
        </Tab>
      )}

      {activeIC ? (
        <>
          <div className="section-pad section-pad--tight">
            <Paragraph typography="t6" color={adaptive.grey600}>
              {activeIC.name}에서 나가는 경로예요
            </Paragraph>
            {connector && hiddenCount > 0 && (
              <TextButton
                size="small"
                variant="underline"
                color={adaptive.grey600}
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll
                  ? `${connectorName(connector)} 충전소만 보기`
                  : `${connectorName(connector)}가 없는 ${hiddenCount}곳을 숨겼어요 · 모두 보기`}
              </TextButton>
            )}
          </div>
          {visibleStations.length === 0 ? (
            <div className="section-pad">
              <Paragraph typography="t5">
                이 IC 근처엔 맞는 충전소가 없어요.
              </Paragraph>
              {maxMinutes < 30 && (
                <>
                  <Spacing size={12} />
                  <Button size="medium" variant="weak" onClick={onWiden}>
                    30분 거리까지 찾아보기
                  </Button>
                </>
              )}
            </div>
          ) : (
            visibleStations.map((s, i) => (
              <StationRow
                key={s.id}
                station={s}
                best={i === 0 && s.is_recommended}
                focused={focusId === s.id}
                onFocus={setFocusId}
              />
            ))
          )}
        </>
      ) : (
        <div className="section-pad">
          <Paragraph typography="t6" color={adaptive.grey600}>
            이 휴게소 근처 IC 정보가 아직 없어요.
          </Paragraph>
        </div>
      )}

      <Border variant="height16" />
      <ListHeader
        title={
          <ListHeader.TitleParagraph fontWeight="bold">
            평소 {weekdayName((now.getDay() + 6) % 7)}요일 혼잡도
          </ListHeader.TitleParagraph>
        }
      />
      <div className="section-pad">
        {pattern.data ? (
          <PatternChart pattern={pattern.data} nowHour={now.getHours()} />
        ) : (
          <Skeleton custom={["card"]} repeatLastItemCount={1} />
        )}
      </div>

      <div className="footnote">
        <Paragraph typography="t7" color={adaptive.grey500}>
          충전기 상태는 환경부 공공데이터 기준이에요. 대기 시간은 휴게소
          급속충전 40분 제한을 바탕으로 한 추정이고, ‘약’이 붙은 거리는
          직선거리로 계산했어요.
        </Paragraph>
      </div>
    </div>
  );
}
