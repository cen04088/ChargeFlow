import { SearchField } from "@toss/tds-mobile";
import { useEffect, useRef, useState } from "react";

import { MIN_QUERY, searchPlaces, type Place } from "../lib/placeSearch";

const DEBOUNCE_MS = 300;

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; places: Place[] }
  | { kind: "error" };

/**
 * 주소·장소 검색창과 결과 목록. 글자를 치면 잠깐 기다렸다가 찾고,
 * 가장 최근 검색어의 결과만 보여 준다.
 */
export function PlaceSearch({
  autoFocus,
  onPick,
}: {
  autoFocus?: boolean;
  onPick: (place: Place) => void;
}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const id = ++seq.current;
    if (q.length < MIN_QUERY) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "loading" });
    const timer = setTimeout(() => {
      searchPlaces(q).then(
        (places) => {
          if (id === seq.current) setState({ kind: "done", places });
        },
        () => {
          if (id === seq.current) setState({ kind: "error" });
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="place-search">
      <SearchField
        placeholder="주소나 장소 이름으로 찾기"
        aria-label="주소나 장소 이름으로 찾기"
        autoFocus={autoFocus}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onDeleteClick={() => setQuery("")}
      />
      <div aria-live="polite">
        {state.kind === "loading" && (
          <p className="place-search__note">찾고 있어요</p>
        )}
        {state.kind === "error" && (
          <p className="place-search__note">
            검색하지 못했어요. 잠시 후 다시 시도하거나 아래에서 지역을 골라 주세요.
          </p>
        )}
        {state.kind === "done" && state.places.length === 0 && (
          <p className="place-search__note">
            찾는 곳이 없어요. 다른 이름이나 주소로 찾아 보세요.
          </p>
        )}
      </div>
      {state.kind === "done" && state.places.length > 0 && (
        <ul className="place-search__list">
          {state.places.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="place-search__item press"
                onClick={() => onPick(p)}
              >
                <span className="place-search__name">{p.name}</span>
                {p.address && (
                  <span className="place-search__addr">{p.address}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
