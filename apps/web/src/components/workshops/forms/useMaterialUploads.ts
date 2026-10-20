'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 工坊「参考资料 · 本地上传」数据钩子(2026-10-20):
 * GET/POST/DELETE /api/workshops/materials 的客户端封装 —— 列表进选择器
 * (uploadMaterialOptions 转 MaterialOption 与交付物混排),上传成功即刷新
 * 并返回新条目 id(表单据此自动勾选),删除后刷新。
 * 组件卸载后不落 state(防弹窗关闭后 setState 警告)。
 */

export interface MaterialUploadItem {
  id: string;
  title: string;
  fileName: string;
  kind: 'text' | 'pdf' | 'docx';
  sizeBytes: number;
  textChars: number;
  createdAt: number;
}

export interface UseMaterialUploads {
  items: MaterialUploadItem[];
  loaded: boolean;
  busy: boolean;
  error: string | null;
  /** 上传一批文件(逐个串行,单个失败不中断其余);返回成功入库的 id 列表 */
  upload: (files: File[]) => Promise<string[]>;
  remove: (id: string) => Promise<void>;
  clearError: () => void;
}

export function useMaterialUploads(): UseMaterialUploads {
  const [items, setItems] = useState<MaterialUploadItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/workshops/materials', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!alive.current) return;
      if (res.ok && data?.success && Array.isArray(data.items)) {
        setItems(data.items);
        setLoaded(true);
      }
      // 列表拉取失败静默(选择器仍可勾交付物;上传动作失败会显式报错)
    } catch {
      // 同上
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = useCallback(
    async (files: File[]): Promise<string[]> => {
      if (files.length === 0) return [];
      setBusy(true);
      setError(null);
      const ids: string[] = [];
      const errors: string[] = [];
      for (const f of files) {
        try {
          const form = new FormData();
          form.append('file', f, f.name);
          const res = await fetch('/api/workshops/materials', { method: 'POST', body: form });
          const data = await res.json().catch(() => null);
          if (res.ok && data?.success && typeof data.item?.id === 'string') {
            ids.push(data.item.id);
          } else {
            errors.push(`${f.name}:${data?.error || `上传失败(HTTP ${res.status})`}`);
          }
        } catch (e: any) {
          errors.push(`${f.name}:${e?.message || String(e)}`);
        }
      }
      await refresh();
      if (!alive.current) return ids;
      if (errors.length > 0) setError(errors.join(';'));
      setBusy(false);
      return ids;
    },
    [refresh]
  );

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/workshops/materials?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          if (alive.current) setError(data?.error || `删除失败(HTTP ${res.status})`);
        }
      } catch (e: any) {
        if (alive.current) setError(e?.message || String(e));
      }
      await refresh();
      if (alive.current) setBusy(false);
    },
    [refresh]
  );

  const clearError = useCallback(() => setError(null), []);

  return { items, loaded, busy, error, upload, remove, clearError };
}
