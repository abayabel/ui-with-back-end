function parseMonth(month) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new RangeError("Month must use the YYYY-MM format.");
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function getMonthlyPassStatus(passMonth, currentMonth) {
  parseMonth(passMonth);
  parseMonth(currentMonth);
  if (passMonth < currentMonth) return "expired";
  if (passMonth > currentMonth) return "upcoming";
  return "active";
}

export function getMonthEndDate(month) {
  const { year, month: monthNumber } = parseMonth(month);
  if (year < 1000) throw new RangeError("Month must have a four-digit calendar year.");
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}
