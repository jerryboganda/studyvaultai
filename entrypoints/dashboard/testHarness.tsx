import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ToastProvider } from '@ui';
import { ApiProvider, type DashboardApi } from './api';
import { VersionProvider } from './hooks';
import { TreeDataContext, type TreeData } from './treeData';

/** Test-only provider stack for dashboard components rendered on their own. */
export function Harness({
  api,
  tree,
  children,
}: {
  api: DashboardApi;
  tree: TreeData;
  children: ReactNode;
}) {
  const [local, setLocal] = useState(0);
  const bump = useCallback(() => setLocal((n) => n + 1), []);
  const value = useMemo(() => ({ local, bump }), [local, bump]);
  return (
    <ApiProvider value={api}>
      <ToastProvider>
        <VersionProvider value={value}>
          <TreeDataContext.Provider value={tree}>{children}</TreeDataContext.Provider>
        </VersionProvider>
      </ToastProvider>
    </ApiProvider>
  );
}
