import { useEffect, useRef, useState } from 'react';
import { BrandIcon } from '../BrandIcon';
import { providerBrand } from '../../data/providerBrand';
import { formatNumber } from '../../data/providerFormat';
import type {
  Available,
  CustomApiProtocol,
  LoginSession,
  Model,
  PatchProviderRequest,
  Provider,
  ThinkingLevel,
} from '../../data/providerTypes';
import { t, type Lang } from '../../i18n';
import { LoginSessionView } from './LoginSessionView';

export const ACP_CATALOG = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    subtitleKey: 'dlg_add_acp_claude_sub' as const,
    brand: 'anthropic',
    pathPlaceholder: '/path/to/claude',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    subtitleKey: 'dlg_add_acp_agy_sub' as const,
    brand: 'google',
    pathPlaceholder: '/path/to/agy',
  },
] as const;

type ConnectBody =
  | { method: 'api_key'; apiKey: string }
  | { method: 'env' }
  | { method: 'local_login' };

type LeftKind = 'vendor' | 'custom' | 'acp';

type LeftItem = {
  kind: LeftKind;
  id: string;
  name: string;
  brand: string | null;
  connected: boolean;
  vendor?: Available;
  acp?: (typeof ACP_CATALOG)[number];
};

type Props = {
  lang: Lang;
  isOpen: boolean;
  onClose: () => void;
  available: readonly Available[];
  loginSession: LoginSession | null;
  onAnswerOAuth: (input: string) => Promise<void>;
  onCancelOAuth: () => Promise<void>;
  onStartOAuth: (vendor: Available) => Promise<void>;
  onConnect: (id: string, body: ConnectBody) => Promise<Provider>;
  onConnectCustom: (form: {
    name: string;
    baseUrl: string;
    api: CustomApiProtocol;
    apiKey?: string;
    defaultModel?: string;
    images?: boolean;
    defaultThinkingLevel?: ThinkingLevel | null;
  }) => Promise<Provider>;
  onCreate: (id: string, patch: {
    name: string;
    enabled: string[];
    defaultModel: string;
    images?: boolean;
    defaultThinkingLevel?: ThinkingLevel | null;
  }) => Promise<void>;
  onRollback: (ids: string[]) => Promise<void>;
  editTarget?: Provider | null;
  onSaveEdit?: (id: string, patch: PatchProviderRequest) => Promise<unknown>;
  onTest?: (id: string) => Promise<unknown>;
  customOnly?: boolean;
};

const CHECK_SVG = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="10" cy="10" r="7.5" />
    <path d="M6.5 10.2l2.4 2.3 4.6-4.8" />
  </svg>
);

const DASH_SVG = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="10" cy="10" r="7.5" strokeDasharray="2.5 2.5" />
  </svg>
);

const EYE_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EYE_OFF_SVG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

const CHEV_SVG = (
  <svg className="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6l4 4 4-4" />
  </svg>
);

function subtitleOf(item: LeftItem, lang: Lang): string {
  if (item.kind === 'acp' && item.acp) return t(lang, item.acp.subtitleKey);
  if (item.kind === 'custom') return t(lang, 'dlg_add_subtitle_custom');
  if (item.id === 'xai') return t(lang, 'dlg_add_subtitle_grok');
  return t(lang, 'dlg_add_subtitle_api', { name: item.name });
}

export function AddProviderDialog({
  lang,
  isOpen,
  onClose,
  available,
  loginSession,
  onAnswerOAuth,
  onCancelOAuth,
  onStartOAuth,
  onConnect,
  onConnectCustom,
  onCreate,
  onRollback,
  editTarget,
  onSaveEdit,
  onTest,
  customOnly,
}: Props) {
  const isEdit = Boolean(editTarget);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string>(() => (
    editTarget
      ? (editTarget.kind === 'custom' ? 'custom' : editTarget.id)
      : (customOnly ? 'custom' : 'xai')
  ));
  const [configName, setConfigName] = useState(() => (editTarget ? editTarget.name : ''));
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [customUrl, setCustomUrl] = useState(() => (editTarget?.baseUrl || ''));
  const [customKey, setCustomKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<Model[]>(() => (editTarget?.models || []));
  const [chosenId, setChosenId] = useState(() => (editTarget ? (editTarget.defaultModel || '') : ''));
  const [imagesSupport, setImagesSupport] = useState<boolean | null>(() => (
    typeof editTarget?.images === 'boolean' ? editTarget.images : null
  ));
  const [thinkingDefault, setThinkingDefault] = useState<ThinkingLevel | null>(() => (
    editTarget?.defaultThinkingLevel || null
  ));
  const [connectedId, setConnectedId] = useState<string | null>(() => (editTarget ? editTarget.id : null));
  const [ddOpen, setDdOpen] = useState(false);
  const [imagesDdOpen, setImagesDdOpen] = useState(false);
  const [thinkingDdOpen, setThinkingDdOpen] = useState(false);
  const [acpFoldOpen, setAcpFoldOpen] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testSuccess, setTestSuccess] = useState(false);
  const [creating, setCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const leftoverRef = useRef<Set<string>>(new Set());
  const autoKeyRef = useRef<string>('');
  const selectedIdRef = useRef(selectedId);
  const isOpenRef = useRef(isOpen);
  const ddRef = useRef<HTMLDivElement | null>(null);
  const imagesDdRef = useRef<HTMLDivElement | null>(null);
  const thinkingDdRef = useRef<HTMLDivElement | null>(null);
  const closingRef = useRef(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const testBtnRef = useRef<HTMLButtonElement | null>(null);
  const onConnectRef = useRef(onConnect);
  const onRollbackRef = useRef(onRollback);
  const onCloseRef = useRef(onClose);
  onConnectRef.current = onConnect;
  onRollbackRef.current = onRollback;
  onCloseRef.current = onClose;
  selectedIdRef.current = selectedId;
  isOpenRef.current = isOpen;


  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ddRef.current && !ddRef.current.contains(target)) setDdOpen(false);
      if (imagesDdRef.current && !imagesDdRef.current.contains(target)) setImagesDdOpen(false);
      if (thinkingDdRef.current && !thinkingDdRef.current.contains(target)) setThinkingDdOpen(false);
    };
    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, []);

  const grokVendor = available.find((item) => item.id === 'xai') || null;
  const apiVendors = available.filter((item) => item.id !== 'xai');

  const isCustomOnly = Boolean(customOnly || isEdit || (!grokVendor && apiVendors.length === 0));

  const editItem: LeftItem | null = editTarget
    ? {
        kind: editTarget.kind === 'custom' ? ('custom' as const) : ('vendor' as const),
        id: editTarget.kind === 'custom' ? 'custom' : editTarget.id,
        name: editTarget.name,
        brand: editTarget.brand || providerBrand(editTarget.id),
        connected: false,
        vendor: available.find((item) => item.id === editTarget.id) || {
          id: editTarget.id,
          name: editTarget.name,
          brand: editTarget.brand || providerBrand(editTarget.id),
          authMethods: [editTarget.auth?.type === 'oauth' ? 'oauth' : 'api_key'],
          modelCount: editTarget.models?.length || 0,
          popular: false,
          envDetected: false,
          connected: true,
        },
      }
    : null;

  const leftItems: LeftItem[] = editItem
    ? [editItem]
    : isCustomOnly
      ? [
          {
            kind: 'custom',
            id: 'custom',
            name: t(lang, 'dlg_add_custom_title'),
            brand: null,
            connected: false,
          },
        ]
      : [
          ...(grokVendor
            ? [{
                kind: 'vendor' as const,
                id: grokVendor.id,
                name: grokVendor.name,
                brand: grokVendor.brand || providerBrand(grokVendor.id),
                connected: grokVendor.connected && !sessionIds.includes(grokVendor.id),
                vendor: grokVendor,
              }]
            : []),
          ...apiVendors.map((vendor) => ({
            kind: 'vendor' as const,
            id: vendor.id,
            name: vendor.name,
            brand: vendor.brand || providerBrand(vendor.id),
            connected: vendor.connected && !sessionIds.includes(vendor.id),
            vendor,
          })),
          {
            kind: 'custom',
            id: 'custom',
            name: t(lang, 'dlg_add_custom_title'),
            brand: null,
            connected: false,
          },
          ...ACP_CATALOG.map((acp) => ({
            kind: 'acp' as const,
            id: acp.id,
            name: acp.name,
            brand: acp.brand,
            connected: false,
            acp,
          })),
        ];

  const selected = leftItems.find((item) => item.id === selectedId) || leftItems[0] || null;
  const vendor = selected?.kind === 'vendor' ? selected.vendor : undefined;
  const isRelogin = Boolean(loginSession && vendor && loginSession.providerId === vendor.id);
  const alreadyConnected = Boolean(
    !isEdit
    && vendor?.connected
    && !sessionIds.includes(vendor.id)
    && !isRelogin,
  );
  const grokDetected = Boolean(vendor?.id === 'xai' && vendor.localLogin?.detected);
  const envDetected = Boolean(vendor?.envDetected);
  const isReady = Boolean((connectedId || isEdit) && models.length > 0 && !alreadyConnected);
  const isAcp = selected?.kind === 'acp';
  const isAcpComingSoon = isAcp;
  const isCustom = selected?.kind === 'custom';
  const isGrok = vendor?.id === 'xai';

  function clearRevertTimer() {
    if (revertTimerRef.current) {
      clearTimeout(revertTimerRef.current);
      revertTimerRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      clearRevertTimer();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    clearRevertTimer();
    leftoverRef.current = new Set();
    autoKeyRef.current = '';
    closingRef.current = false;
    setSessionIds([]);
    setSearch('');
    if (editTarget) {
      setSelectedId(editTarget.kind === 'custom' ? 'custom' : editTarget.id);
      setConfigName(editTarget.name);
      setCustomUrl(editTarget.baseUrl || '');
      setCustomKey('');
      setShowKey(false);
      setModels(editTarget.models || []);
      setChosenId(editTarget.defaultModel || '');
      setImagesSupport(typeof editTarget.images === 'boolean' ? editTarget.images : null);
      setThinkingDefault(editTarget.defaultThinkingLevel || null);
      setConnectedId(editTarget.id);
    } else {
      setSelectedId(customOnly ? 'custom' : 'xai');
      setConfigName('');
      setApiKeyInput('');
      setCustomUrl('');
      setCustomKey('');
      setShowKey(false);
      setModels([]);
      setChosenId('');
      setConnectedId(null);
      setImagesSupport(null);
      setThinkingDefault(null);
    }
    setDdOpen(false);
    setImagesDdOpen(false);
    setThinkingDdOpen(false);
    setAcpFoldOpen(false);
    setOauthOpen(false);
    setTesting(false);
    setTestSuccess(false);
    setCreating(false);
    setErrorMsg(null);
  }, [isOpen, editTarget, customOnly]);

  useEffect(() => {
    if (!isOpen || editTarget) return;
    if (selectedId === 'custom') return;
    const acp = ACP_CATALOG.find((item) => item.id === selectedId);
    if (acp) {
      setConfigName(acp.name);
      return;
    }
    const hit = available.find((item) => item.id === selectedId);
    if (hit) setConfigName(hit.name);
  }, [isOpen, selectedId, available, editTarget]);

  useEffect(() => {
    if (!isOpen) return;
    const hit = available.find((item) => item.id === selectedId);
    if (!hit || hit.connected) return;
    const key = hit.id === 'xai'
      ? (hit.localLogin?.detected ? `local:${hit.id}` : '')
      : (hit.envDetected ? `env:${hit.id}` : '');
    if (!key || autoKeyRef.current === key) return;
    const id = hit.id;
    const body: ConnectBody = hit.id === 'xai' ? { method: 'local_login' } : { method: 'env' };
    setTesting(true);
    setErrorMsg(null);
    void Promise.resolve(onConnectRef.current(id, body)).then((provider) => {
      if (!provider) return;
      if (!isOpenRef.current || closingRef.current) {
        void onRollbackRef.current([provider.id]);
        return;
      }
      leftoverRef.current.add(provider.id);
      setSessionIds([...leftoverRef.current]);
      if (selectedIdRef.current !== id) return;
      autoKeyRef.current = key;
      setConnectedId(provider.id);
      setModels(provider.models);
      setChosenId((prev) => prev || provider.models[0]?.id || '');
      setErrorMsg(null);
    }).catch((err: unknown) => {
      if (selectedIdRef.current !== id) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setConnectedId(null);
      setModels([]);
    }).finally(() => {
      if (selectedIdRef.current === id) setTesting(false);
    });
  }, [isOpen, selectedId, available]);

  useEffect(() => {
    if (loginSession?.state === 'done' && loginSession.provider && selectedId === loginSession.providerId) {
      leftoverRef.current.add(loginSession.provider.id);
      setSessionIds([...leftoverRef.current]);
      setConnectedId(loginSession.provider.id);
      setModels(loginSession.provider.models);
      setChosenId((prev) => prev || loginSession.provider?.models[0]?.id || '');
      setErrorMsg(null);
      setOauthOpen(false);
    }
  }, [loginSession, selectedId]);

  const sessionId = loginSession?.id;
  useEffect(() => {
    if (loginSession && isOpen) {
      setSelectedId(loginSession.providerId);
      setOauthOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (ddOpen) {
        setDdOpen(false);
        return;
      }
      if (closingRef.current) return;
      clearRevertTimer();
      setTesting(false);
      setTestSuccess(false);
      closingRef.current = true;
      const ids = [...leftoverRef.current];
      leftoverRef.current = new Set();
      void (async () => {
        try { if (ids.length) await onRollbackRef.current(ids); } catch { /* still close */ }
        onCloseRef.current();
      })();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, ddOpen]);

  useEffect(() => {
    if (!ddOpen) return;
    function onDown(e: MouseEvent) {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) setDdOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [ddOpen]);

  if (!isOpen || !selected) return null;

  function remember(provider: Provider) {
    if (!isOpenRef.current || closingRef.current) {
      void onRollbackRef.current([provider.id]);
      return;
    }
    leftoverRef.current.add(provider.id);
    setSessionIds([...leftoverRef.current]);
    setConnectedId(provider.id);
    setModels(provider.models);
    setChosenId((prev) => prev || provider.models[0]?.id || '');
    setErrorMsg(null);
  }

  async function executeConnect(
    connectPromise: Promise<Provider>,
    targetId: string,
    isExplicit: boolean,
  ) {
    clearRevertTimer();
    setTesting(true);
    setTestSuccess(false);
    setErrorMsg(null);
    try {
      const minDelayPromise = isExplicit
        ? new Promise<void>((resolve) => {
            setTimeout(resolve, 500);
          })
        : Promise.resolve();

      const [connectResult] = await Promise.allSettled([connectPromise, minDelayPromise]);

      if (!isOpenRef.current || closingRef.current || selectedIdRef.current !== targetId) {
        if (connectResult.status === 'fulfilled' && connectResult.value) {
          void onRollbackRef.current([connectResult.value.id]);
        }
        return;
      }

      if (connectResult.status === 'fulfilled') {
        const provider = connectResult.value;
        remember(provider);
        setTesting(false);
        if (isExplicit) {
          setTestSuccess(true);
          revertTimerRef.current = setTimeout(() => {
            if (isOpenRef.current && !closingRef.current && selectedIdRef.current === targetId) {
              setTestSuccess(false);
            }
          }, 1500);
        }
      } else {
        const err = connectResult.reason;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setConnectedId(null);
        setModels([]);
        setTesting(false);
        setTestSuccess(false);
      }
    } catch (err) {
      if (!isOpenRef.current || closingRef.current || selectedIdRef.current !== targetId) {
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setConnectedId(null);
      setModels([]);
      setTesting(false);
      setTestSuccess(false);
    }
  }

  async function runConnect(body: ConnectBody, isExplicit = false) {
    if (!vendor || alreadyConnected) return;
    try {
      const connectPromise = Promise.resolve(onConnect(vendor.id, body));
      await executeConnect(connectPromise, vendor.id, isExplicit);
    } catch (err) {
      if (!isOpenRef.current || closingRef.current || selectedIdRef.current !== vendor.id) {
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setConnectedId(null);
      setModels([]);
      setTesting(false);
      setTestSuccess(false);
    }
  }

  async function runCustomConnect(isExplicit = false) {
    const name = configName.trim() || t(lang, 'dlg_add_custom_title');
    if (!customUrl.trim()) {
      setErrorMsg(t(lang, 'form_fill_required'));
      return;
    }
    try {
      const connectPromise = Promise.resolve(onConnectCustom({
        name,
        baseUrl: customUrl.trim(),
        api: 'openai-completions',
        ...(customKey.trim() ? { apiKey: customKey.trim() } : {}),
        defaultModel: chosenId || undefined,
        ...(imagesSupport !== null ? { images: imagesSupport } : {}),
        ...(thinkingDefault !== null ? { defaultThinkingLevel: thinkingDefault } : {}),
      }));
      await executeConnect(connectPromise, 'custom', isExplicit);
    } catch (err) {
      if (!isOpenRef.current || closingRef.current || selectedIdRef.current !== 'custom') {
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setConnectedId(null);
      setModels([]);
      setTesting(false);
      setTestSuccess(false);
    }
  }

  async function executeTestExisting(id: string) {
    if (!onTest) return;
    clearRevertTimer();
    setTesting(true);
    setTestSuccess(false);
    setErrorMsg(null);
    try {
      const minDelayPromise = new Promise<void>((resolve) => { setTimeout(resolve, 500); });
      const [res] = await Promise.allSettled([onTest(id), minDelayPromise]);
      if (!isOpenRef.current || closingRef.current) return;
      if (res.status === 'fulfilled') {
        setTesting(false);
        setTestSuccess(true);
        revertTimerRef.current = setTimeout(() => {
          if (isOpenRef.current && !closingRef.current) setTestSuccess(false);
        }, 1500);
      } else {
        const err = res.reason;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setTesting(false);
        setTestSuccess(false);
      }
    } catch (err) {
      if (!isOpenRef.current || closingRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setTesting(false);
      setTestSuccess(false);
    }
  }

  async function handleTest() {
    if (isAcp || alreadyConnected || testing || testSuccess || creating) return;
    if (isCustom) {
      if (customKey.trim() || !isEdit) {
        await runCustomConnect(true);
      } else if (isEdit && onTest && editTarget) {
        await executeTestExisting(editTarget.id);
      }
      return;
    }
    if (!vendor) return;
    if (vendor.id === 'xai') {
      if (vendor.localLogin?.detected) await runConnect({ method: 'local_login' }, true);
      else {
        setOauthOpen(true);
        await onStartOAuth(vendor);
      }
      return;
    }
    if (apiKeyInput.trim()) await runConnect({ method: 'api_key', apiKey: apiKeyInput.trim() }, true);
    else if (vendor.envDetected) await runConnect({ method: 'env' }, true);
    else if (isEdit && onTest && editTarget) await executeTestExisting(editTarget.id);
    else setErrorMsg(t(lang, 'form_fill_required'));
  }

  async function handleKeyBlur(e?: React.FocusEvent<HTMLInputElement>) {
    if (alreadyConnected || testing || creating || isAcp) return;
    if (e?.relatedTarget && e.relatedTarget === testBtnRef.current) {
      return;
    }
    if (isCustom) {
      if (customUrl.trim() && (customKey.trim() || configName.trim())) await runCustomConnect(false);
      return;
    }
    if (vendor && apiKeyInput.trim()) {
      await runConnect({ method: 'api_key', apiKey: apiKeyInput.trim() }, false);
    }
  }

  async function handleCancel() {
    clearRevertTimer();
    setTesting(false);
    setTestSuccess(false);
    if (closingRef.current) return;
    closingRef.current = true;
    const ids = [...leftoverRef.current];
    leftoverRef.current = new Set();
    try {
      if (ids.length) await onRollback(ids);
    } catch { /* still close */ }
    onClose();
  }

  async function handleCreate() {
    if (editTarget) {
      setCreating(true);
      setErrorMsg(null);
      try {
        const patch: PatchProviderRequest = {
          name: (configName.trim() || editTarget.name).slice(0, 80),
        };
        if (isCustom) {
          const initialImages = typeof editTarget.images === 'boolean' ? editTarget.images : null;
          if (imagesSupport !== initialImages) {
            patch.images = imagesSupport;
          }
          const initialThinking = editTarget.defaultThinkingLevel || null;
          if (thinkingDefault !== initialThinking) {
            patch.defaultThinkingLevel = thinkingDefault;
          }
          if (customUrl.trim()) patch.baseUrl = customUrl.trim();
          if (customKey.trim()) patch.apiKey = customKey.trim();
        } else {
          if (apiKeyInput.trim()) patch.apiKey = apiKeyInput.trim();
        }
        if (chosenId && chosenId !== (editTarget.defaultModel || '')) {
          patch.defaultModel = chosenId;
        }
        await onSaveEdit?.(editTarget.id, patch);
        onClose();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setCreating(false);
      }
      return;
    }

    if (!isReady || !connectedId || creating) return;
    const defaultModel = chosenId || models[0]?.id;
    if (!defaultModel) return;
    setCreating(true);
    setErrorMsg(null);
    try {
      leftoverRef.current.delete(connectedId);
      const leftover = [...leftoverRef.current];
      leftoverRef.current = new Set();
      await onCreate(connectedId, {
        name: (configName.trim() || selected.name).slice(0, 80),
        enabled: models.map((item) => item.id),
        defaultModel,
        ...(isCustom ? {
          ...(imagesSupport !== null ? { images: imagesSupport } : {}),
          ...(thinkingDefault !== null ? { defaultThinkingLevel: thinkingDefault } : {}),
        } : {}),
      });
      if (leftover.length) await onRollback(leftover);
      onClose();
    } catch (err) {
      leftoverRef.current.add(connectedId);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (isOpenRef.current && !closingRef.current) {
        setCreating(false);
      }
    }
  }

  function handleSelect(item: LeftItem) {
    if (item.id === selectedId) return;
    clearRevertTimer();
    setSelectedId(item.id);
    setConfigName(item.kind === 'custom' ? '' : item.name);
    setApiKeyInput('');
    setCustomUrl('');
    setCustomKey('');
    setErrorMsg(null);
    setDdOpen(false);
    setOauthOpen(false);
    setAcpFoldOpen(false);
    setTesting(false);
    setTestSuccess(false);
    setCreating(false);
    setModels([]);
    setChosenId('');
    setConnectedId(null);
    autoKeyRef.current = '';
    setImagesSupport(null);
    setThinkingDefault(null);
  }

  const q = search.trim().toLowerCase();
  const match = (item: LeftItem) => !q || item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q);
  const builtinList = leftItems.filter((item) => item.kind === 'vendor' && item.id === 'xai').filter(match);
  const apiList = leftItems.filter((item) => (item.kind === 'vendor' && item.id !== 'xai') || item.kind === 'custom').filter(match);
  const acpList = leftItems.filter((item) => item.kind === 'acp').filter(match);

  const chosen = (chosenId ? models.find((item) => item.id === chosenId) : null)
    || (!editTarget ? models[0] : null)
    || null;
  const grokAccount = vendor?.localLogin?.account || '';

  function renderGroup(label: string, items: LeftItem[]) {
    if (!items.length) return null;
    return (
      <>
        <div className="mp-add-grp">{label}</div>
        {items.map((item) => (
          <div
            key={item.id}
            className={`mp-add-it${item.id === selected.id ? ' on' : ''}${item.connected ? ' dis' : ''}`}
            data-testid="next-vendor-card"
            data-vendor={item.id}
            onClick={() => handleSelect(item)}
          >
            <span className="mp-av">
              <BrandIcon brand={item.brand} size={14} />
            </span>
            <span className="mp-add-n">{item.name}</span>
            {item.connected
              ? <span className="mp-add-s">{t(lang, 'dlg_add_already_connected')}</span>
              : item.id === selected.id ? <span className="mp-add-ck">✓</span> : null}
          </div>
        ))}
      </>
    );
  }

  return (
    <div className="mp-mask mp-mask-add">
      <div className="mp-dlg mp-dlg-add" data-testid="next-add-dialog">
        <div className="mp-add-left">
          <input
            className="mp-add-search"
            data-testid="next-add-search"
            placeholder={t(lang, 'dlg_add_search_placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="mp-add-list">
            {isCustomOnly ? (
              renderGroup(t(lang, 'dlg_add_custom_title'), leftItems)
            ) : (
              <>
                {renderGroup(t(lang, 'dlg_add_grp_builtin'), builtinList)}
                {renderGroup(t(lang, 'dlg_add_grp_apikey'), apiList)}
                {renderGroup(t(lang, 'dlg_add_grp_acp'), acpList)}
              </>
            )}
          </div>
        </div>
        <div className="mp-add-right">
          <div className="mp-add-head">
            <span className="mp-av mp-add-logo">
              <BrandIcon brand={selected.brand} size={18} />
            </span>
            <div>
              <b>{isEdit ? t(lang, 'provider_act_edit') : t(lang, 'dlg_add_provider_title')}</b>
              <small>{subtitleOf(selected, lang)}</small>
            </div>
            <span className="mp-add-sp">
              <button
                ref={testBtnRef}
                type="button"
                className="mp-btn"
                data-testid="next-add-test"
                disabled={testing || testSuccess || creating}
                onClick={() => void handleTest()}
              >
                {testing
                  ? t(lang, 'provider_status_run')
                  : testSuccess
                    ? t(lang, 'provider_btn_connected')
                    : t(lang, 'provider_btn_test')}
              </button>
              <button type="button" className="mp-x" data-testid="next-add-close" onClick={() => void handleCancel()}>×</button>
            </span>
          </div>

          <div className="mp-add-form">
            <div className="mp-add-f">
              <label>{t(lang, 'dlg_add_config_name')}</label>
              <div className="mp-add-in">
                <input
                  data-testid={isCustom ? 'next-custom-name' : 'next-config-name'}
                  value={configName}
                  disabled={alreadyConnected}
                  onChange={(e) => setConfigName(e.target.value)}
                />
              </div>
            </div>

            {alreadyConnected && (
              <div className="mp-add-sub">{t(lang, 'dlg_add_already_connected')}</div>
            )}

            {!alreadyConnected && isGrok && (
              <div className="mp-add-f">
                <label>{t(lang, 'dlg_add_grok_account')}</label>
                <div className="mp-add-in">
                  {grokDetected && !(errorMsg && !connectedId) ? (
                    <>
                      <input
                        data-testid="next-grok-detected"
                        value={t(lang, 'dlg_add_grok_detected', { account: grokAccount })}
                        disabled
                      />
                      <span className="mp-add-det ok" data-testid="next-detected-check">{CHECK_SVG}</span>
                    </>
                  ) : oauthOpen ? (
                    <div style={{ flex: 1 }}>
                      <LoginSessionView
                        session={loginSession}
                        lang={lang}
                        onAnswer={onAnswerOAuth}
                        onCancel={async () => {
                          setOauthOpen(false);
                          await onCancelOAuth();
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="mp-btn mp-pri"
                      data-testid="next-grok-login"
                      onClick={() => {
                        setOauthOpen(true);
                        if (vendor) void onStartOAuth(vendor);
                      }}
                    >
                      {t(lang, 'dlg_add_grok_login')}
                    </button>
                  )}
                </div>
              </div>
            )}

            {!alreadyConnected && isCustom && (
              <>
                <div className="mp-add-f">
                  <label>{t(lang, 'dlg_custom_url_label')}</label>
                  <div className="mp-add-in">
                    <input
                      className="mono"
                      data-testid="next-custom-url"
                      value={customUrl}
                      placeholder={t(lang, 'dlg_custom_url_placeholder')}
                      onChange={(e) => {
                        setCustomUrl(e.target.value);
                        setTestSuccess(false);
                      }}
                      onBlur={(e) => void handleKeyBlur(e)}
                    />
                  </div>
                </div>
                <div className="mp-add-f">
                  <label>{t(lang, 'dlg_key_label')}</label>
                  <div className="mp-add-in">
                    <input
                      type={showKey ? 'text' : 'password'}
                      className="mono"
                      data-testid="next-custom-key"
                      value={customKey}
                      placeholder={isEdit ? '••••••••••••••••' : 'sk-…'}
                      onChange={(e) => {
                        setCustomKey(e.target.value);
                        setTestSuccess(false);
                      }}
                      onBlur={(e) => void handleKeyBlur(e)}
                    />
                    <button
                      type="button"
                      className="mp-key-toggle"
                      data-testid="next-key-toggle"
                      title={showKey ? t(lang, 'dlg_key_hide') : t(lang, 'dlg_key_show')}
                      onClick={() => setShowKey((s) => !s)}
                    >
                      {showKey ? EYE_OFF_SVG : EYE_SVG}
                    </button>
                  </div>
                </div>
              </>
            )}

            {!alreadyConnected && !isGrok && !isCustom && !isAcp && vendor && (
              <div className="mp-add-f">
                <label>{t(lang, 'dlg_key_label')}</label>
                <div className="mp-add-in">
                  <input
                    type={showKey ? 'text' : 'password'}
                    className="mono"
                    data-testid="next-key-input"
                    value={apiKeyInput}
                    placeholder={isEdit ? '••••••••••••••••' : (envDetected && vendor.envVar
                      ? t(lang, 'dlg_add_env_placeholder', { env: vendor.envVar })
                      : 'sk-…')}
                    onChange={(e) => {
                      setApiKeyInput(e.target.value);
                      setTestSuccess(false);
                    }}
                    onBlur={(e) => void handleKeyBlur(e)}
                  />
                  {envDetected && !isEdit ? (
                    <span className="mp-add-det ok" data-testid="next-detected-check">
                      {CHECK_SVG}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="mp-key-toggle"
                      data-testid="next-key-toggle"
                      title={showKey ? t(lang, 'dlg_key_hide') : t(lang, 'dlg_key_show')}
                      onClick={() => setShowKey((s) => !s)}
                    >
                      {showKey ? EYE_OFF_SVG : EYE_SVG}
                    </button>
                  )}
                </div>
              </div>
            )}

            {isAcp && selected.acp && (
              <>
                <div className="mp-add-f">
                  <label>{t(lang, 'dlg_add_runtime_path')}</label>
                  <div className="mp-add-in">
                    <input
                      className="mono"
                      placeholder={selected.acp.pathPlaceholder}
                      disabled
                    />
                    <span className="mp-add-det">{DASH_SVG}</span>
                  </div>
                </div>
                <div className={`mp-add-fold${acpFoldOpen ? ' open' : ''}`}>
                  <div className="fh" onClick={() => setAcpFoldOpen((open) => !open)}>
                    {t(lang, 'dlg_add_custom_prompt')}
                  </div>
                  <div className="fb">
                    <textarea disabled />
                  </div>
                </div>
              </>
            )}

            {!isAcp && !alreadyConnected && (
              <div className="mp-add-f">
                <label>{t(lang, 'dlg_add_default_model')}</label>
                <div className="mp-add-in">
                  <div className="mp-add-dd" ref={ddRef}>
                    <button
                      type="button"
                      className={`mp-add-dd-btn${ddOpen ? ' open' : ''}`}
                      data-testid="next-add-model-dropdown"
                      disabled={!isReady}
                      onClick={() => isReady && setDdOpen((open) => !open)}
                    >
                      {isReady ? (chosen ? chosen.name : t(lang, 'provider_default_unselected')) : t(lang, 'dlg_add_models_pending')}
                      {CHEV_SVG}
                    </button>
                    {ddOpen && isReady && (
                      <div className="mp-add-dd-menu">
                        {models.map((model) => {
                          const on = Boolean(chosen && model.id === chosen.id);
                          return (
                            <div
                              key={model.id}
                              className={`mp-add-dd-it${on ? ' on' : ''}`}
                              data-testid="next-add-model-option"
                              data-model={model.id}
                              onClick={() => {
                                setChosenId(model.id);
                                setDdOpen(false);
                              }}
                            >
                              <span className="ck">{on ? '✓' : ''}</span>
                              <span>{model.name}</span>
                              {model.contextWindow != null ? (
                                <span className="cx">{formatNumber(model.contextWindow)}</span>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {!isAcpComingSoon && !alreadyConnected && isCustom && (
              <>
                <div className="mp-add-f">
                  <label>{t(lang, 'dlg_add_images_label')}</label>
                  <div className="mp-add-in">
                    <div className="mp-add-dd" ref={imagesDdRef}>
                      <button
                        type="button"
                        className={`mp-add-dd-btn${imagesDdOpen ? ' open' : ''}`}
                        data-testid="next-add-images-dropdown"
                        onClick={() => setImagesDdOpen((o) => !o)}
                      >
                        <span>
                          {imagesSupport === null
                            ? t(lang, 'dlg_add_follow_model')
                            : imagesSupport
                              ? t(lang, 'dlg_add_images_supported')
                              : t(lang, 'dlg_add_images_unsupported')}
                        </span>
                        {CHEV_SVG}
                      </button>
                      {imagesDdOpen && (
                        <div className="mp-add-dd-menu" data-testid="next-add-images-menu">
                          <div
                            className={`mp-add-dd-it${imagesSupport === null ? ' on' : ''}`}
                            data-testid="next-add-images-option-follow"
                            onClick={() => {
                              setImagesSupport(null);
                              setImagesDdOpen(false);
                            }}
                          >
                            <span className="ck">{imagesSupport === null ? '✓' : ''}</span>
                            <span>{t(lang, 'dlg_add_follow_model')}</span>
                          </div>
                          <div
                            className={`mp-add-dd-it${imagesSupport === true ? ' on' : ''}`}
                            data-testid="next-add-images-option-supported"
                            onClick={() => {
                              setImagesSupport(true);
                              setImagesDdOpen(false);
                            }}
                          >
                            <span className="ck">{imagesSupport === true ? '✓' : ''}</span>
                            <span>{t(lang, 'dlg_add_images_supported')}</span>
                          </div>
                          <div
                            className={`mp-add-dd-it${imagesSupport === false ? ' on' : ''}`}
                            data-testid="next-add-images-option-unsupported"
                            onClick={() => {
                              setImagesSupport(false);
                              setImagesDdOpen(false);
                            }}
                          >
                            <span className="ck">{imagesSupport === false ? '✓' : ''}</span>
                            <span>{t(lang, 'dlg_add_images_unsupported')}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mp-add-f">
                  <label>{t(lang, 'dlg_add_thinking_label')}</label>
                  <div className="mp-add-in">
                    <div className="mp-add-dd" ref={thinkingDdRef}>
                      <button
                        type="button"
                        className={`mp-add-dd-btn${thinkingDdOpen ? ' open' : ''}`}
                        data-testid="next-add-thinking-dropdown"
                        onClick={() => setThinkingDdOpen((o) => !o)}
                      >
                        <span>
                          {thinkingDefault === null
                            ? t(lang, 'dlg_add_follow_model')
                            : thinkingDefault === 'off'
                              ? t(lang, 'dlg_add_thinking_off')
                              : thinkingDefault === 'low'
                                ? t(lang, 'dlg_add_thinking_low')
                                : thinkingDefault === 'medium'
                                  ? t(lang, 'dlg_add_thinking_medium')
                                  : thinkingDefault === 'high'
                                    ? t(lang, 'dlg_add_thinking_high')
                                    : thinkingDefault}
                        </span>
                        {CHEV_SVG}
                      </button>
                      {thinkingDdOpen && (
                        <div className="mp-add-dd-menu" data-testid="next-add-thinking-menu">
                          {[
                            { id: null, testId: 'follow', label: t(lang, 'dlg_add_follow_model') },
                            { id: 'off' as const, testId: 'off', label: t(lang, 'dlg_add_thinking_off') },
                            { id: 'low' as const, testId: 'low', label: t(lang, 'dlg_add_thinking_low') },
                            { id: 'medium' as const, testId: 'medium', label: t(lang, 'dlg_add_thinking_medium') },
                            { id: 'high' as const, testId: 'high', label: t(lang, 'dlg_add_thinking_high') },
                          ].map((lvl) => {
                            const on = thinkingDefault === lvl.id;
                            return (
                              <div
                                key={lvl.testId}
                                className={`mp-add-dd-it${on ? ' on' : ''}`}
                                data-testid={`next-add-thinking-option-${lvl.testId}`}
                                onClick={() => {
                                  setThinkingDefault(lvl.id);
                                  setThinkingDdOpen(false);
                                }}
                              >
                                <span className="ck">{on ? '✓' : ''}</span>
                                <span>{lvl.label}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}

            {errorMsg && <div className="mp-add-err" data-testid="next-test-result">{errorMsg}</div>}
          </div>

          <div className="mp-add-foot">
            <button type="button" className="mp-btn" data-testid="next-add-cancel" onClick={() => void handleCancel()}>
              {t(lang, 'dlg_cancel')}
            </button>
            {isAcp ? (
              <button type="button" className="mp-btn mp-pri" data-testid="next-acp-coming" disabled>
                {t(lang, 'dlg_add_coming')}
              </button>
            ) : (
              <button
                type="button"
                className="mp-btn mp-pri"
                data-testid="next-provider-finish"
                disabled={creating || (!isReady && !isEdit)}
                onClick={() => void handleCreate()}
              >
                {creating ? t(lang, 'provider_status_run') : isEdit ? t(lang, 'btn_save') : t(lang, 'dlg_add_create')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
