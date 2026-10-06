const TIME_ZONE = 'Asia/Tokyo';

const dateKeyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 日本時間の日付キー（YYYY-MM-DD） */
export function jstDateKey(date: string | Date): string {
  return dateKeyFormat.format(new Date(date));
}

/** 日付キー（YYYY-MM-DD）を、その日の日本時間 0 時の Date にする */
export function dateFromKey(key: string): Date {
  return new Date(`${key}T00:00:00+09:00`);
}
