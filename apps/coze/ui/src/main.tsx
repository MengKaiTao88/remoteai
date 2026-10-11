import React from "react";
import { createRoot } from "react-dom/client";
import { App as AntApp, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { Studio } from "./Studio";
import "./styles.css";

const dark = sessionStorage.getItem("coze-theme") === "dark";
document.documentElement.dataset.theme = dark ? "dark" : "light";
document.documentElement.dataset.embedded = String(window.parent !== window);
createRoot(document.getElementById("root")!).render(<React.StrictMode>
  <ConfigProvider locale={zhCN} theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: { colorPrimary: "#635bdb", borderRadius: 9 } }}>
    <AntApp><Studio /></AntApp>
  </ConfigProvider>
</React.StrictMode>);
