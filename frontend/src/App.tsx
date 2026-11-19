import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useSearchParams,
} from "react-router-dom";

import HighwayPage from "./pages/HighwayPage";
import HomePage from "./pages/HomePage";
import NearbyPage from "./pages/NearbyPage";
import RestAreaPage from "./pages/RestAreaPage";
import TripPage from "./pages/TripPage";

/** 구버전 공유 링크(?hw=&dir=&ra=)로 들어오면 상세 화면으로 보낸다. 아니면 내 주변 충전소 홈 */
function Root() {
  const [params] = useSearchParams();
  const ra = params.get("ra");
  if (ra && /^\d+$/.test(ra))
    return <Navigate to={`/rest-area/${ra}`} replace />;
  return <NearbyPage />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Root />} />
        <Route path="/highways" element={<HomePage />} />
        <Route path="/highway/:code" element={<HighwayPage />} />
        <Route path="/rest-area/:id" element={<RestAreaPage />} />
        <Route path="/trip" element={<TripPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
