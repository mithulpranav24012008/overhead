// Places to look up from, each with its clock. Height is left at sea level: it changes nothing you could see here.
const raw = `Delhi|28.61|77.21|Asia/Kolkata
Mumbai|19.08|72.88|Asia/Kolkata
Chennai|13.08|80.27|Asia/Kolkata
Bengaluru|12.97|77.59|Asia/Kolkata
Kolkata|22.57|88.36|Asia/Kolkata
Hyderabad|17.39|78.49|Asia/Kolkata
Colombo|6.93|79.86|Asia/Colombo
Dhaka|23.81|90.41|Asia/Dhaka
Karachi|24.86|67|Asia/Karachi
Kathmandu|27.72|85.32|Asia/Kathmandu
Dubai|25.2|55.27|Asia/Dubai
Riyadh|24.71|46.68|Asia/Riyadh
Tehran|35.69|51.39|Asia/Tehran
Istanbul|41.01|28.98|Europe/Istanbul
Cairo|30.04|31.24|Africa/Cairo
Lagos|6.52|3.38|Africa/Lagos
Nairobi|-1.29|36.82|Africa/Nairobi
Johannesburg|-26.2|28.05|Africa/Johannesburg
Cape Town|-33.92|18.42|Africa/Johannesburg
London|51.51|-0.13|Europe/London
Dublin|53.35|-6.26|Europe/Dublin
Paris|48.86|2.35|Europe/Paris
Madrid|40.42|-3.7|Europe/Madrid
Lisbon|38.72|-9.14|Europe/Lisbon
Rome|41.9|12.5|Europe/Rome
Berlin|52.52|13.4|Europe/Berlin
Amsterdam|52.37|4.9|Europe/Amsterdam
Stockholm|59.33|18.07|Europe/Stockholm
Oslo|59.91|10.75|Europe/Oslo
Warsaw|52.23|21.01|Europe/Warsaw
Athens|37.98|23.73|Europe/Athens
Moscow|55.76|37.62|Europe/Moscow
Reykjavik|64.15|-21.94|Atlantic/Reykjavik
New York|40.71|-74.01|America/New_York
Boston|42.36|-71.06|America/New_York
Washington|38.91|-77.04|America/New_York
Toronto|43.65|-79.38|America/Toronto
Chicago|41.88|-87.63|America/Chicago
Houston|29.76|-95.37|America/Chicago
Denver|39.74|-104.99|America/Denver
Los Angeles|34.05|-118.24|America/Los_Angeles
San Francisco|37.77|-122.42|America/Los_Angeles
Seattle|47.61|-122.33|America/Los_Angeles
Vancouver|49.28|-123.12|America/Vancouver
Anchorage|61.22|-149.9|America/Anchorage
Honolulu|21.31|-157.86|Pacific/Honolulu
Mexico City|19.43|-99.13|America/Mexico_City
Bogotá|4.71|-74.07|America/Bogota
Lima|-12.05|-77.04|America/Lima
Santiago|-33.45|-70.67|America/Santiago
Buenos Aires|-34.6|-58.38|America/Argentina/Buenos_Aires
São Paulo|-23.55|-46.63|America/Sao_Paulo
Beijing|39.9|116.41|Asia/Shanghai
Shanghai|31.23|121.47|Asia/Shanghai
Hong Kong|22.32|114.17|Asia/Hong_Kong
Taipei|25.03|121.57|Asia/Taipei
Seoul|37.57|126.98|Asia/Seoul
Tokyo|35.68|139.69|Asia/Tokyo
Bangkok|13.76|100.5|Asia/Bangkok
Singapore|1.35|103.82|Asia/Singapore
Kuala Lumpur|3.14|101.69|Asia/Kuala_Lumpur
Jakarta|-6.21|106.85|Asia/Jakarta
Manila|14.6|120.98|Asia/Manila
Sydney|-33.87|151.21|Australia/Sydney
Melbourne|-37.81|144.96|Australia/Melbourne
Perth|-31.95|115.86|Australia/Perth
Auckland|-36.85|174.76|Pacific/Auckland`;
export const CITIES = raw.split("\n").map((line) => {
  const [name, lat, lon, zone] = line.split("|");
  return { name, lat: +lat, lon: +lon, zone };
});
// A first guess from the device's own time zone, which asks for no permission and tells nobody anything.
export function guessCity() {
  let zone = "";
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  return CITIES.find((c) => c.zone === zone) ?? CITIES.find((c) => c.name === "London");
}
