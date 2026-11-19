import { describe, expect, it } from "vitest";
import { mergePlaces, type RawAddress, type RawPlace } from "./placeSearch";

const addr = (name: string, x = "127.0", y = "37.5"): RawAddress => ({
  address_name: name,
  x,
  y,
});
const place = (id: string, name: string, over: Partial<RawPlace> = {}): RawPlace => ({
  id,
  place_name: name,
  address_name: "서울 중구 태평로1가 31",
  road_address_name: "서울 중구 세종대로 110",
  x: "126.978",
  y: "37.5665",
  ...over,
});

describe("mergePlaces", () => {
  it("주소를 앞에, 장소를 뒤에 둔다", () => {
    const r = mergePlaces([addr("서울 중구 세종대로 110")], [place("1", "서울시청")]);
    expect(r.map((p) => p.name)).toEqual(["서울 중구 세종대로 110", "서울시청"]);
    expect(r[0]).toMatchObject({ address: "", lat: 37.5, lng: 127 });
  });

  it("장소는 도로명 주소를 먼저 쓰고 없으면 지번 주소를 쓴다", () => {
    const r = mergePlaces(
      [],
      [place("1", "가"), place("2", "나", { road_address_name: "" })],
    );
    expect(r[0].address).toBe("서울 중구 세종대로 110");
    expect(r[1].address).toBe("서울 중구 태평로1가 31");
  });

  it("좌표가 깨졌거나 이름이 없는 줄은 버린다", () => {
    const r = mergePlaces(
      [addr("깨진 주소", "abc", "37.5"), addr("")],
      [place("1", "", {}), place("2", "정상")],
    );
    expect(r.map((p) => p.name)).toEqual(["정상"]);
  });

  it("이름과 좌표가 같은 줄은 한 번만 남긴다", () => {
    const r = mergePlaces([], [place("1", "서울시청"), place("2", "서울시청")]);
    expect(r).toHaveLength(1);
  });

  it("정한 개수까지만 남긴다", () => {
    const many = Array.from({ length: 12 }, (_, i) => place(String(i), `곳${i}`));
    expect(mergePlaces([], many)).toHaveLength(8);
    expect(mergePlaces([], many, 3)).toHaveLength(3);
  });
});
