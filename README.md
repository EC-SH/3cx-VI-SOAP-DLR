# 3cx-SMS-VI-Connector-DLR

upgrade of the apidaze version — switches outbound to the voip innovations soap api to get delivery receipts

---

## what changed from the apidaze version

| | apidaze version | this version |
|---|---|---|
| outbound api | apidaze rest | vi soap (SendSMSWithDLR) |
| delivery receipts | no | yes, /dlr callback |
| auth | api key + secret | vi api login + password |
| inbound | same | same |

---

## architecture

```
inbound:  cell -> sangoma did -> /inbound -> 3cx
outbound: 3cx -> /outbound -> vi soap api -> cell
dlr:      vi -> /dlr (delivery receipt callback)
```

---

## endpoints

### POST /inbound
receives sangoma webhook, translates to 3cx generic sms envelope, forwards to 3cx

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

---

### POST /outbound
receives 3cx outbound sms, calls vi soap SendSMSWithDLR, registers /dlr as callback

3cx sends:
```json
{ "from": "+13052314933", "to": "+13057673260", "text": "hello" }
```

vi soap call:
```xml
<SendSMSWithDLR>
  <login>engagesms</login>
  <password>...</password>
  <from>13052314933</from>
  <to>13057673260</to>
  <message>hello</message>
  <dlrUrl>https://your-service/dlr</dlrUrl>
</SendSMSWithDLR>
```

note: vi rejects e164 + prefix — stripped automatically

---

### POST /dlr
delivery receipt callback from vi. fires when message is delivered or fails.

vi posts something like:
```
status=delivered&to=13057673260&msgid=...
```

currently logs to console. wire to bigquery or forward to 3cx as needed.

---

### GET /
health check — returns `3CX-Sangoma SMS Middleware is running.`

---

## env vars

| var | required | description |
|---|---|---|
| `VI_LOGIN` | yes | vi api username (backoffice > api users) |
| `VI_PASSWORD` | yes | vi api password |
| `THREECX_WEBHOOK_URL` | yes | inbound webhook url from 3cx sms tab |
| `OUTBOUND_URL` | yes | this service's own url (used to build dlr callback) |
| `PORT` | no | defaults to 8080, cloud run sets automatically |

copy `.env.example` to `.env` for local dev

---

## deploy

```bash
gcloud run deploy threecx-sms-outbound-dlr \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars VI_LOGIN=engagesms,VI_PASSWORD=yourpass,THREECX_WEBHOOK_URL=https://your-3cx/webhook,OUTBOUND_URL=https://your-new-service-url
```

inbound deploy unchanged from apidaze version

---

## vi api reference

soap endpoint: `https://backoffice.voipinnovations.com/Services/APIService.asmx`

relevant operations:
- `SendSMS` — send without delivery receipt
- `SendSMSWithDLR` — send with delivery receipt callback (this is what we use)
- `AuditSMS` — query sent message history
- `SendSMSWithDLR` SOAPAction: `http://tempuri.org/SendSMSWithDLR`

full wsdl: `https://backoffice.voipinnovations.com/Services/APIService.asmx?WSDL`

---

## 10dlc

still required. same campaign as the apidaze version. carrier approval carries over.

---

## local dev

```bash
npm install
cp .env.example .env
node index.js
```

---

## important — if you forked this

the `.env.example` contains placeholder values only. before deploying you must replace every value with your own credentials and URLs. do not copy `.env.example` as-is and deploy it — it will not work and you will be hitting someone else's endpoint.

you need:
- your own vi api login from backoffice.voipinnovations.com
- your own 3cx webhook url
- your own cloud run service url as OUTBOUND_URL
