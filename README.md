# 3cx-SMS-VI-Connector-DLR

upgrade of the apidaze version — switches outbound to the voip innovations soap api to get delivery receipts

---

## what changed from the apidaze version

| | apidaze version | this version |
|---|---|---|
| outbound api | apidaze rest | vi soap (SendSMSWithDLR) |
| delivery receipts | no | yes, per-DID, lands on /inbound or /dlr |
| auth to provider | api key + secret | vi api login + secret |
| auth to this service | none | shared secret (`WEBHOOK_SECRET`) |
| inbound | same | same |

---

## architecture

```
inbound:  cell -> sangoma did -> /inbound -> 3cx
outbound: 3cx -> /outbound -> vi soap api -> cell
dlr:      vi -> did destination url (/inbound or /dlr) — logged
```

---

## auth

every webhook route checks `WEBHOOK_SECRET` (when set). present it as any of:

- `X-Auth-Token: <secret>` — set this as a custom header on the 3cx generic sms provider (same convention as the apidaze connector)
- `Authorization: Bearer <secret>`
- `X-Webhook-Secret: <secret>`
- `?secret=<secret>` on the url — for vi / sangoma destinations that can't set headers. prefer a header wherever the caller supports one: cloud run request logs and the provider's own outbound logs record full urls, query string included (this service strips it from its own log lines only)

wrong or missing secret = bare 401. constant-time compare. leave `WEBHOOK_SECRET` blank and everything is open (a warning is logged at boot) — don't do that on a public cloud run url, `/outbound` sends sms on your account.

---

## endpoints

### POST /inbound
receives the vi/sangoma DID destination webhook, translates to 3cx generic sms envelope, forwards to 3cx

sangoma sends:
```json
{
  "type": "incomingWebhookSMS",
  "caller_id_number": "13057673260",
  "destination_number": "13052314933",
  "text": "hello"
}
```

translated to 3cx:
```json
{
  "data": {
    "event_type": "message.received",
    "payload": {
      "from": { "phone_number": "+13057673260", "status": "webhook_delivered" },
      "to": [{ "phone_number": "+13052314933", "status": "webhook_delivered" }],
      "text": "hello",
      "type": "SMS"
    }
  }
}
```

returns 200 always — suppresses sangoma retries

anything posted here that isn't an incoming sms (no `caller_id_number`/`destination_number`, `type` not `incomingWebhookSMS`) is treated as a delivery receipt / status event — see `/dlr`

---

### POST /outbound
receives 3cx outbound sms, calls vi soap SendSMSWithDLR

3cx sends:
```json
{ "from": "+13052314933", "to": "+13057673260", "text": "hello" }
```

vi soap call (element names per the wsdl — there is no per-message callback url):
```xml
<SendSMSWithDLR xmlns="http://tempuri.org/">
  <login>engagesms</login>
  <secret>...</secret>
  <sender>13052314933</sender>
  <recipient>13057673260</recipient>
  <message>hello</message>
</SendSMSWithDLR>
```

notes:
- vi rejects e164 `+` prefix — stripped automatically
- every value is xml-escaped, so `&`, `<`, quotes in the text are safe
- vi answers http 200 even when it refuses the message; the verdict is `responseCode` (100 = accepted). anything else → this service returns **502** to 3cx so the message shows as failed instead of sent. `responseMessage` is in the logs
- accepted → 200 `{ "ok": true, "uuid": "<vi message uuid>" }` (3cx needs a non-empty body to mark "sent")
- vi unreachable → 503

---

### POST /dlr
delivery receipt / status callback from vi. also accepted on `/inbound` (see above).

there is no per-message dlr url in the vi api. receipts are enabled per DID — `UpdateSMSDLR` in the api, or back office > sms > your DID > DLR — and, as far as the wsdl shows (`SMSDID.DLR` next to `DestinationType`/`Destination`), vi posts them to that DID's configured destination (destination type **API POST**). point that destination at this service (`/inbound?secret=...` or `/dlr?secret=...`). **verify on the first receipt** — look for the `DLR / status callback received` line in the cloud run logs; both routes accept it either way.

vi posts form-encoded, roughly:
```
status=delivered&to=13057673260&msgid=...
```

currently logs query + body to console (secret stripped). wire to bigquery as needed. forwarding to 3cx is not useful today: the generic sms provider ignores delivery status — only 3cx-supported providers get the second "delivered" tick.

---

### GET /
health check — returns `3CX-Sangoma SMS Middleware is running.`

---

## env vars

| var | required | description |
|---|---|---|
| `VI_LOGIN` | yes | vi api username (backoffice > api users) |
| `VI_PASSWORD` | yes | vi api password (sent as the wsdl's `secret` element) |
| `THREECX_WEBHOOK_URL` | yes | inbound webhook url from 3cx sms tab |
| `WEBHOOK_SECRET` | strongly recommended | shared secret for /inbound, /outbound, /dlr — see auth |
| `OUTBOUND_URL` | no | this service's own url; only used to print the urls to configure at boot |
| `PORT` | no | defaults to 8080, cloud run sets automatically |

copy `.env.example` to `.env` for local dev

---

## deploy

```bash
gcloud run deploy threecx-sms-outbound-dlr \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars VI_LOGIN=engagesms,VI_PASSWORD=yourpass,THREECX_WEBHOOK_URL=https://your-3cx/webhook,WEBHOOK_SECRET=$(openssl rand -hex 24),OUTBOUND_URL=https://your-new-service-url
```

then:
- **3cx** — sms tab, provider generic, url `https://<service>/outbound`, custom header `X-Auth-Token: <WEBHOOK_SECRET>`
- **vi back office** — sms > your DID: destination type API POST, url `https://<service>/inbound?secret=<WEBHOOK_SECRET>`, DLR on

inbound deploy unchanged from apidaze version

---

## vi api reference

soap endpoint: `https://backoffice.voipinnovations.com/Services/APIService.asmx`

relevant operations (all take `login` + `secret`):
- `SendSMS(sender, recipient, message)` — send without delivery receipt
- `SendSMSWithDLR(sender, recipient, message)` — send with delivery receipt (this is what we use). SOAPAction: `http://tempuri.org/SendSMSWithDLR`
- `UpdateSMSDLR(tns[], dlr)` — turn delivery receipts on/off for a list of DIDs
- `ConfigSMSDestination(tn, destinationType, destination, authToken)` — where vi posts inbound sms + receipts for a DID
- `AuditSMS(tn)` — query sent message history

response type for the send ops is `SMSResponse`: `responseCode` (int, 100 = success), `responseMessage`, `Uuid`, `MsgDetails { success, code, data, status, uuid }`

full wsdl: `https://backoffice.voipinnovations.com/Services/APIService.asmx?WSDL`

---

## 10dlc

still required. same campaign as the apidaze version. carrier approval carries over.

---

## local dev

```bash
npm install
cp .env.example .env      # fill in your values
npm run dev               # node --env-file=.env index.js (node 20.6+)
```

---

## important — if you forked this

the `.env.example` contains placeholder values only. before deploying you must replace every value with your own credentials and URLs. do not copy `.env.example` as-is and deploy it — it will not work and you will be hitting someone else's endpoint.

you need:
- your own vi api login from backoffice.voipinnovations.com
- your own 3cx webhook url
- your own `WEBHOOK_SECRET` (anything long and random)
