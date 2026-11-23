import { BrowserRouter, Route, Routes } from "react-router-dom";
import MineralFutures from "@/pages/MineralFutures";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="*" element={<MineralFutures />} />
      </Routes>
    </BrowserRouter>
  );
}
