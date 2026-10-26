# Admin Analytics API (read-only)

Base: `/api/admin/analytics/*` (same prefix/auth as other admin routes: header `x-admin-key: <token>`).
All endpoints are `GET`, read-only, cached ~60s server-side. Timezone for all bucketing/heatmaps: **IST (Asia/Kolkata)**.

## Common params
| param | notes |
|---|---|
| `from`, `to` | `YYYY-MM-DD` (interpreted as IST day start / day end) or full ISO datetime. Default: last 30 days ending now. Range capped to 365 days (`range.capped=true` if trimmed). `from > to` -> 400. |

Every JSON response has `success`, `range`, and (for multi-query endpoints) `warnings`:
```json
"range": {"from":"2026-09-30T18:30:00.000Z","to":"2026-10-25T18:29:59.999Z",
          "previousFrom":"...","previousTo":"...","timezone":"Asia/Kolkata","capped":false},
"warnings": []   // e.g. [{"section":"by_coupon","error":"query_failed"}] - that section is returned empty/zero, rest is intact
```
Errors: `400 {success:false,error}` for bad input, `500` on total failure.
"Previous period" = the equally long window immediately before `from`.

## GET /analytics/overview
Each metric is `{current, previous, change, deltaPct}`; `deltaPct` is `null` when previous is 0 and current > 0.
Revenue/AOV in INR. `conversionRate` is percent of created orders with status `paid`. `downloads` = successful downloads (DownloadLog.errorMsg IS NULL, paid + free).
```json
{"success":true,"range":{...},"warnings":[],
 "revenue":{"current":4646,"previous":2424,"change":2222,"deltaPct":91.7},
 "orders":{...},"paidOrders":{...},"conversionRate":{...},"averageOrderValue":{...},
 "newUsers":{...},"downloads":{...}}
```

## GET /analytics/timeseries
Params: `metric=revenue|orders|users|downloads` (default revenue), `interval=day|week|month` (default day; weeks start Monday; month = 1st).
Gap-filled (zeros). `date` is the IST bucket start date. Revenue counts only `paid` orders; orders counts all statuses.
```json
{"success":true,"range":{...},"metric":"revenue","interval":"week","total":4646,
 "series":[{"date":"2026-09-28","value":483},{"date":"2026-10-05","value":540}]}
```

## GET /analytics/revenue-breakdown
Paid orders only except `byStatus`.
```json
{"success":true,"range":{...},"warnings":[],
 "byTemplate":[{"templateId":"..","templateName":"Golden Legacy","paidOrders":18,"revenue":882}],
 "byCoupon":{"withCoupon":{"paidOrders":10,"revenue":400,"discountGiven":120},
             "withoutCoupon":{"paidOrders":67,"revenue":4246},
             "codes":[{"code":"WELCOME","paidOrders":5,"revenue":200,"discountGiven":50}]},
 "byStatus":[{"status":"paid","orders":77,"amount":4646},{"status":"pending","orders":10,"amount":0}],
 "byFormat":[{"format":"pdf","paidOrders":40,"revenue":2000}],
 "heatmap":{"timezone":"Asia/Kolkata","dowLabels":["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],
            "grid":[[{"paidOrders":0,"revenue":0} /* x24 hours */] /* x7 days, index 0 = Sunday */]}}
```

## GET /analytics/top-templates
Params: `sort=downloads|revenue` (default downloads), `limit` 1-50 (default 10).
`downloads` = successful DownloadLog rows in range (split free = no orderId / paid).
```json
{"success":true,"range":{...},"sort":"downloads","limit":10,
 "templates":[{"templateId":"..","templateName":"..","downloads":12,"freeDownloads":5,"paidDownloads":7,"paidOrders":7,"revenue":343}]}
```

## GET /analytics/funnel
No preview/view events exist in the DB, so the funnel starts at **order creation**. Steps: created -> paid -> downloaded (order `downloadStatus='success'` OR a successful DownloadLog for it).
```json
{"success":true,"range":{...},"note":"...",
 "steps":[{"key":"orderCreated","label":"...","count":90,"pctOfPrevious":100,"pctOfFirst":100},
          {"key":"paid","count":77,"pctOfPrevious":85.6,"pctOfFirst":85.6},
          {"key":"downloaded","count":70,"pctOfPrevious":90.9,"pctOfFirst":77.8}],
 "dropOffs":{"paymentFailedOrAbandoned":13,"paymentFailedStatus":2,"paidButNoSuccessfulDownload":7,"paidDownloadFailed":0},
 "paidOrdersByDownloadStatus":[{"status":"success","orders":70},{"status":"(none)","orders":7}],
 "freeDownloads":120,"referralClicks":34}
```

## GET /analytics/affiliates
Param: `limit` 1-50 (top affiliates, default 10). `payoutsPending` is a **current snapshot**, not range-bound.
`conversions` = non-rejected Commission rows created in range.
```json
{"success":true,"range":{...},"warnings":[],
 "clicks":0,"uniqueVisitors":0,"signups":0,"signupsByStatus":{"pending":1},
 "conversions":0,"clickToConversionRate":0,
 "referredPaidOrders":{"orders":0,"revenue":0},
 "commissions":{"totalEarned":0,"byStatus":{"pending":{"count":4,"commission":1.3,"orderAmount":10}}},
 "payoutsPending":{"withdrawalRequests":{"count":0,"amount":0},
                   "unpaidCommissions":{"pending":{"count":4,"amount":1.3},"approved":{"count":0,"amount":0}}},
 "topAffiliates":[{"id":"..","name":"..","code":"BG1025","tier":"standard","status":"approved",
                   "conversions":3,"orderAmount":300,"commission":90,"clicks":40}]}
```

## GET /analytics/feedback
Param: `interval=day|week|month` (default day) for the trend.
```json
{"success":true,"range":{...},"interval":"day","total":5,"averageRating":4.8,
 "previous":{"total":3,"averageRating":5},
 "distribution":[{"rating":5,"count":4,"pct":80},{"rating":4,"count":1,"pct":20},{"rating":3,"count":0,"pct":0},{"rating":2,"count":0,"pct":0},{"rating":1,"count":0,"pct":0}],
 "trend":[{"date":"2026-10-01","count":0,"averageRating":null}]}
```

## GET /analytics/export
Params: `type=orders|users|downloads` (required), `from`, `to`, optional `limit` (max 50000, also the default cap).
Returns a streamed `text/csv` (UTF-8 with BOM, attachment filename `<type>_<from>_<to>.csv`), oldest first. Fetch with the `x-admin-key` header (or `?token=` for a plain link).
Columns - orders: id, razorpayOrderId, razorpayPaymentId, amount, currency, status, format, templateId, customerName, customerEmail, customerPhone, couponCode, discountApplied, downloadStatus, referralCode, createdAt. users: id, name, email, role, status, createdAt (no password). downloads: id, name, location, format, templateId, orderId, errorMsg, createdAt (no IP/user-agent). Cells starting with `= + - @` are prefixed with `'` to block spreadsheet formula injection.
