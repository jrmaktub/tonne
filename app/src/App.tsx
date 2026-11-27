import { BrowserRouter, Route, Routes } from "react-router-dom";
import MineralFutures from "@/pages/MineralFutures";

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="*" element={<MineralFutures />} />
      </Routes>
    </BrowserRouter>
  );
}
