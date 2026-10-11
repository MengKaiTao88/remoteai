import { lazy, Suspense, useEffect, useState } from "react";
import { guiText } from "../../i18n/guiText";
import styles from "./CozePage.module.less";

const CozePage = lazy(() => import("./CozePage"));

export function CozeTab({ active }: { active: boolean }) {
  const [visited, setVisited] = useState(active);
  useEffect(() => { if (active) setVisited(true); }, [active]);
  // Keep the editor mounted across main-menu navigation so drafts and the current view survive.
  return <section className={styles.panel} hidden={!active} aria-label="Coze">
    {(active || visited) && <Suspense fallback={<div className={styles.welcome} role="status">
      {guiText("正在加载…")}
    </div>}>
      <CozePage active={active} />
    </Suspense>}
  </section>;
}
