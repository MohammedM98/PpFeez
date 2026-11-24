import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, TriangleAlert } from 'lucide-react';
import { api, native } from '@/lib/api';
import type { BackupFile } from '@/lib/contract';
import { Dialog } from './Dialog';
import { Button } from './Button';
import { TextField } from './TextField';
import { Checkbox } from './Field';
import { toast } from './Toast';
import { Trunc } from './Trunc';

/**
 * Backup before a delete (SPEC 4.7). `auto`: taken when a folder is set, otherwise the person
 * picks one or explicitly continues without it. `required`: no folder, no delete. `none`: not shown.
 */
export type BackupMode = 'auto' | 'required' | 'none';

function BackupNotice({ mode, skip, setSkip }: { mode: BackupMode; skip: boolean; setSkip: (v: boolean) => void }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  if (mode === 'none' || !settings.data) return null;
  const dir = settings.data.backupDir;
  const pick = async () => {
    const d = await native.pickFolder();
    if (!d) return;
    await api.updateSettings({ backupDir: d });
    await qc.invalidateQueries({ queryKey: ['settings'] });
  };
  if (dir) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-fg-3">
        <span>تُؤخذ نسخة احتياطية قبل الحذف في</span><Trunc className="min-w-0 max-w-[260px] text-fg-2">{dir}</Trunc>
      </div>
    );
  }
  return (
    <div className="rounded-card bg-warn-soft px-4 py-3 text-sm">
      <p className="font-medium text-warn">لم يُحدَّد مجلد للنسخ الاحتياطي</p>
      <p className="mt-0.5 text-fg-2">{mode === 'required' ? 'النسخة الاحتياطية إلزامية قبل هذا الحذف، فهي طريقتك الوحيدة للتراجع.' : 'بلا نسخة احتياطية لا يمكن التراجع عن الحذف.'}</p>
      <div className="mt-2 flex items-center gap-4">
        <Button size="sm" variant="secondary" onPress={() => void pick()}><FolderOpen />اختيار مجلد</Button>
        {mode === 'auto' && <Checkbox isSelected={skip} onChange={setSkip}>المتابعة بلا نسخة</Checkbox>}
      </div>
    </div>
  );
}

/** Success message; when a backup was taken it says where, and how to undo. */
export function deletedToast(title: string, backup: BackupFile | null | undefined) {
  if (backup) toast.ok(title, `نسخة احتياطية قبل الحذف: ${backup.path}. للتراجع: الإعدادات ← النسخ الاحتياطي ← استعادة`);
  else toast.ok(title);
}

type Props = {
  title: string;
  /** what will be deleted and its effect, from the backend preview */
  children: ReactNode;
  confirmLabel: string;
  onConfirm: (reason: string) => Promise<unknown>;
  onClose: () => void;
  pending?: boolean;
  backup: BackupMode;
  /** typed confirmation: the exact text to type (a customer name, or «حذف») */
  typeToConfirm?: { label: ReactNode; expected: string; error?: string };
  withReason?: boolean;
  isLoading?: boolean;
};

export function DangerConfirm({ title, children, confirmLabel, onConfirm, onClose, pending, backup, typeToConfirm, withReason = true, isLoading }: Props) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [skip, setSkip] = useState(false);
  const hasDir = !!settings.data?.backupDir;
  const backupOk = backup === 'none' || hasDir || (backup === 'auto' && skip);
  const typedOk = !typeToConfirm || typed.trim() === typeToConfirm.expected;
  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width="md"
      title={<span className="flex items-center gap-2 text-neg"><TriangleAlert className="size-5" strokeWidth={1.7} />{title}</span>}
      footer={<>
        <Button variant="secondary" onPress={onClose}>تراجع</Button>
        <Button variant="danger" isPending={pending} isDisabled={isLoading || !backupOk || !typedOk} onPress={() => void onConfirm(reason.trim())}>{confirmLabel}</Button>
      </>}>
      <div className="flex flex-col gap-4">
        {children}
        <p className="text-[13px] text-fg-3">الحذف نهائي، ويُسجَّل ما حُذف في سجل التغييرات.</p>
        <BackupNotice mode={backup} skip={skip} setSkip={setSkip} />
        {withReason && <TextField label="السبب (اختياري)" value={reason} onChange={setReason} />}
        {typeToConfirm && (
          <TextField label={typeToConfirm.label} value={typed} onChange={setTyped} autoFocus errorMessage={typeToConfirm.error} />
        )}
      </div>
    </Dialog>
  );
}
