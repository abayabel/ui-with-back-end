const weeklyDiscounts = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3];

export function getSubscriptionEstimate({ fare, month, weekdays, roundTrip = false }) {
  const [year, monthNumber] = month.split("-").map(Number);
  const selectedWeekdays = [...new Set(weekdays)];
  if (!Number.isFinite(fare) || fare <= 0 || !Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new RangeError("A positive fare and valid calendar month are required.");
  }
  if (!selectedWeekdays.length || selectedWeekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new RangeError("Select between one and seven valid weekdays.");
  }

  const discount = weeklyDiscounts[selectedWeekdays.length - 1];
  const discountedFare = Math.round(fare * (1 - discount) * 100) / 100;
  let weekdayOccurrences = 0;
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    if (selectedWeekdays.includes(new Date(year, monthNumber - 1, day).getDay())) {
      weekdayOccurrences += 1;
    }
  }
  const tripCount = weekdayOccurrences * (roundTrip ? 2 : 1);
  const total = Math.round(discountedFare * tripCount * 100) / 100;
  return { discount, discountedFare, weekdayOccurrences, tripCount, total };
}
