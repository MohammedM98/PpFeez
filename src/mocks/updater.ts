// Browser-mode updater. ?update=1 offers 0.2.0; ?updateError=network|signature|download fails.
import type { UpdaterImpl } from '@/lib/updater';

const NOTES = `## 0.2.0

- اختيار نطاق السحب: الجديد منذ آخر سحب، آخر 7 أو 30 أو 90 يوماً، من تاريخ إلى تاريخ، أو كل الرسائل.
- التحديث التلقائي: يتحقق البرنامج من الإصدارات الجديدة ويثبّتها بعد نسخة احتياطية.
- إصلاح ظهور علامة % في أوصاف القيود.`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mockUpdater(params: URLSearchParams): UpdaterImpl {
  const error = params.get('updateError');
  return {
    async check() {
      await wait(400);
      if (error === 'network') throw new Error('error sending request: connection refused');
      if (params.get('update') !== '1' && !error) return null;
      return {
        version: '0.2.0', currentVersion: '0.1.0', date: new Date().toISOString(), notes: NOTES,
        async install(onProgress) {
          const total = 8_400_000;
          for (let got = 0; got < total; got += 700_000) {
            await wait(180);
            onProgress(Math.min(got + 700_000, total), total);
            if (error === 'download' && got > total / 2) throw new Error('download failed: stream closed');
          }
          if (error === 'signature') throw new Error('signature verification failed');
        },
      };
    },
    async relaunch() {
      console.info('[mock] relaunch');
      location.reload();
    },
  };
}
