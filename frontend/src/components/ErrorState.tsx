import { Result } from "@toss/tds-mobile";
import { useNavigate } from "react-router-dom";

import { ApiError } from "../api/client";

export function ErrorState({
  error,
  onRetry,
}: {
  error?: Error;
  onRetry: () => void;
}) {
  const navigate = useNavigate();
  // 없는 휴게소·노선이면 다시 불러와도 소용없으니 처음 화면으로 안내한다
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Result
        title="찾을 수 없는 정보예요"
        description={error.message}
        button={
          <Result.Button onClick={() => navigate("/", { replace: true })}>
            처음 화면으로
          </Result.Button>
        }
      />
    );
  }
  return (
    <Result
      title="정보를 불러오지 못했어요"
      description={error?.message ?? "잠시 후 다시 시도해 주세요."}
      button={<Result.Button onClick={onRetry}>다시 불러오기</Result.Button>}
    />
  );
}
