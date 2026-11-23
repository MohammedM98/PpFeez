import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { DateTime } from '@/components/ui/DateTime';
import { Badge } from '@/components/ui/Badge';
import { parseStatus } from '@/lib/strings';
import type { ReactNode } from 'react';

// The original email is shown isolated: sandbox="" blocks scripts, forms and navigation,
// and the CSP below blocks every external load (no tracking pixels or remote images).
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function EmailViewer({ id, onClose, actions }: { id: number; onClose: () => void; actions?: ReactNode }) {
  const { data: e } = useQuery({ queryKey: ['email', id], queryFn: () => api.emailGet(id) });
  const body = e?.bodyHtml ?? (e?.bodyText ? `<pre style="white-space:pre-wrap;font:14px/1.6 sans-serif">${escapeHtml(e.bodyText)}</pre>` : '<p style="font-family:sans-serif;color:#888">لا يوجد محتوى</p>');
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="xl" title={e ? <bdi>{e.subject}</bdi> : 'الرسالة'}
      description={e && (
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <bdi dir="ltr">{e.fromAddr}</bdi>
          <DateTime iso={e.receivedAt} />
          <span>{e.mailboxLabel}</span>
          <Badge tone={e.parseStatus === 'failed' ? 'neg' : e.parseStatus === 'parsed' ? 'pos' : 'neutral'}>{parseStatus[e.parseStatus]}</Badge>
          {e.parseReasonAr && <span className="text-fg-3">{e.parseReasonAr}</span>}
        </span>
      )}
      footer={<>{actions}<Button variant="secondary" onPress={onClose}>إغلاق</Button></>}>
      <div className="overflow-hidden rounded-card border border-line bg-white">
        {e && <iframe title="محتوى الرسالة" sandbox="" srcDoc={`<!doctype html><html><head>${CSP}<meta charset="utf-8"></head><body style="margin:16px;background:#fff;color:#111">${body}</body></html>`} className="block h-[56vh] w-full" />}
      </div>
      <p className="mt-2 text-[12.5px] text-fg-3">تُعرض الرسالة معزولة: بلا سكربتات ولا صور خارجية</p>
    </Dialog>
  );
}
