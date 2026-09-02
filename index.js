const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');

const app = express();
app.use(express.json());
// VI delivers status/DLR callbacks form-encoded (status=delivered&to=...),
// not JSON — without this parser req.body on /dlr is always {}.
app.use(express.urlencoded({ extended: false }));

// --- Configuration ---
const VI_LOGIN            = process.env.VI_LOGIN;
const VI_PASSWORD         = process.env.VI_PASSWORD;
const THREECX_WEBHOOK_URL = process.env.THREECX_WEBHOOK_URL;
const OUTBOUND_URL        = process.env.OUTBOUND_URL;        // optional, only used for the boot hint
const WEBHOOK_SECRET      = process.env.WEBHOOK_SECRET || '';
const PORT = process.env.PORT || 8080;
// ---------------------

const VI_API_URL = 'https://backoffice.voipinnovations.com/Services/APIService.asmx';

// VI API v3 convention: responseCode 100 = success, anything else is an
// application-level failure (bad login, unregistered 10DLC, ...) with the
// reason in responseMessage — and it still comes back as HTTP 200.
const VI_SUCCESS_CODE = 100;

// Helper: ensure E.164 format, handles 10/11-digit US numbers and array inputs
const formatE164 = (num) => {
    if (Array.isArray(num)) num = num[0];
    if (!num) return '';
    num = String(num).trim().replace(/\D/g, '');
    if (num.length === 10) num = '1' + num;
    return '+' + num;
};

// --- Shared-secret gate -----------------------------------------------------
// Cloud Run runs this with --allow-unauthenticated, so without a secret anyone
// who finds the URL can send SMS on the VI account. The secret is accepted as
//   X-Auth-Token: <secret>          (custom header on 3CX's Generic SMS provider —
//                                   same convention as 3cx-SMS-VI-Connector)
//   Authorization: Bearer <secret>
//   X-Webhook-Secret: <secret>
//   ?secret=<secret>                (for callers that can't set headers: the VI
//                                   DID destination URL, Sangoma's webhook URL)
// Constant-time compare; rejection is a bare 401 with no hint which was wrong.
// With WEBHOOK_SECRET unset every request passes and a warning is logged at boot.
function secretMatches(provided) {
    if (!provided) return false;
    const a = Buffer.from(String(provided));
    const b = Buffer.from(WEBHOOK_SECRET);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireSecret(req, res, next) {
    if (!WEBHOOK_SECRET) return next();
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const candidates = [
        req.get('x-auth-token'),
        bearer && bearer[1],
        req.get('x-webhook-secret'),
        req.query.secret,
    ];
    if (candidates.some(secretMatches)) return next();
    console.warn(`auth rejected: ${req.method} ${req.path} from ${req.ip}`);
    return res.status(401).end();
}

// --- XML helpers -------------------------------------------------------------
// The SOAP body is built by string interpolation, so every value must be
// XML-escaped — an '&' in a text ("AT&T") would otherwise produce a malformed
// envelope and the send would fail.
const XML_ESC = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
const XML_UNESC = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };
const xmlEsc   = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => XML_ESC[c]);
const xmlUnesc = (s) => String(s).replace(/&(lt|gt|amp|apos|quot|#(\d+));/g,
    (m, name, num) => (num ? String.fromCodePoint(Number(num)) : XML_UNESC[name]));

// First <name>...</name> text in a SOAP response. VI's SMSResponse is flat
// (responseCode / responseMessage / Uuid), so this beats pulling in an XML
// parser for three fields.
function xmlTag(xml, name) {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
    return m ? xmlUnesc(m[1].trim()) : null;
}

// --- DLR / status callbacks --------------------------------------------------
// VI has no per-message callback URL (the WSDL's SendSMSWithDLR takes only
// login/secret/sender/recipient/message). Delivery receipts are enabled per
// DID — UpdateSMSDLR, or Back Office > SMS > DID > DLR — and arrive at the
// DID's configured POST destination, which is normally the same URL that
// receives inbound SMS. So /dlr and /inbound both accept them: anything on
// /inbound that isn't an incoming SMS is handled as a status event.
function isInboundSms(body) {
    return !!body && (body.type === 'incomingWebhookSMS' ||
        (body.caller_id_number != null && body.destination_number != null));
}

function handleDlr(req, res) {
    const { secret, ...query } = req.query;   // never log the secret
    console.log('--- DLR / status callback received ---');
    console.log('Query:', JSON.stringify(query));
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    // TODO: persist to BigQuery. Forwarding to 3CX is pointless today — the
    // Generic SMS provider ignores delivery status (only 3CX-supported
    // providers get the second "delivered" tick).
    res.status(200).send('OK');
}

/**
 * 1. INBOUND: Sangoma/VI -> 3CX
 * Sangoma POSTs here when an SMS arrives on your DID.
 * Sangoma uses non-standard field names: caller_id_number, destination_number
 */
app.post('/inbound', requireSecret, async (req, res) => {
    try {
        const sangomaBody = req.body;
        if (!isInboundSms(sangomaBody)) return handleDlr(req, res);

        console.log('--- Received Inbound SMS from Sangoma ---');
        console.log('Payload:', JSON.stringify(sangomaBody, null, 2));

        const fromNumber  = formatE164(sangomaBody.caller_id_number);
        const toNumber    = formatE164(sangomaBody.destination_number);
        const messageText = sangomaBody.text || '';
        const messageId   = sangomaBody.id || `msg-${Date.now()}`;

        if (!fromNumber || !toNumber) {
            console.error('ERROR: Missing caller_id_number or destination_number in Sangoma payload.');
            return res.status(200).send('Missing fields');
        }

        if (!THREECX_WEBHOOK_URL) {
            console.error('ERROR: THREECX_WEBHOOK_URL is not set.');
            return res.status(200).send('Missing 3CX Webhook config');
        }

        // 3CX Generic SMS requires full Telnyx-style nested envelope
        const threeCxPayload = {
            data: {
                id: messageId,
                event_type: "message.received",
                occurred_at: new Date().toISOString(),
                record_type: "event",
                payload: {
                    direction: "inbound",
                    type: "SMS",
                    record_type: "message",
                    received_at: new Date().toISOString(),
                    text: messageText,
                    from: {
                        phone_number: fromNumber,
                        status: "webhook_delivered"
                    },
                    to: [
                        {
                            phone_number: toNumber,
                            status: "webhook_delivered"
                        }
                    ]
                }
            }
        };

        console.log('Sending to 3CX:', JSON.stringify(threeCxPayload, null, 2));

        const cxResponse = await axios.post(THREECX_WEBHOOK_URL, threeCxPayload, {
            headers: { 'Content-Type': 'application/json' }
        });

        console.log('3CX Response Status:', cxResponse.status);
        res.status(200).send('OK');

    } catch (error) {
        console.error('Error forwarding to 3CX:', error.message);
        res.status(200).send('Error processed');
    }
});

/**
 * 2. OUTBOUND: 3CX -> VoIP Innovations SOAP API (SendSMSWithDLR)
 * 3CX POSTs { from, to, text } here when a user sends an SMS from the 3CX app.
 */
app.post('/outbound', requireSecret, async (req, res) => {
    try {
        console.log('--- Received Outbound SMS from 3CX ---');
        console.log('Payload:', JSON.stringify(req.body, null, 2));

        const cxBody = req.body;

        const fromNumber  = formatE164(cxBody.from).replace('+', '');
        const toNumber    = formatE164(cxBody.to).replace('+', '');
        const messageText = cxBody.text || cxBody.body || '';

        if (!fromNumber || !toNumber || !messageText) {
            console.error('ERROR: Missing from, to, or text in 3CX payload.');
            return res.status(400).send('Missing required fields');
        }

        if (!VI_LOGIN || !VI_PASSWORD) {
            console.error('ERROR: VI_LOGIN or VI_PASSWORD not set.');
            return res.status(500).send('Server configuration error');
        }

        // Element names per the WSDL: login / secret / sender / recipient / message.
        // VI rejects the E.164 '+' prefix, so from/to go in as bare digits.
        const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SendSMSWithDLR xmlns="http://tempuri.org/">
      <login>${xmlEsc(VI_LOGIN)}</login>
      <secret>${xmlEsc(VI_PASSWORD)}</secret>
      <sender>${xmlEsc(fromNumber)}</sender>
      <recipient>${xmlEsc(toNumber)}</recipient>
      <message>${xmlEsc(messageText)}</message>
    </SendSMSWithDLR>
  </soap:Body>
</soap:Envelope>`;

        console.log(`Sending to VI SOAP API: ${fromNumber} -> ${toNumber}, ${messageText.length} chars`);

        const viResponse = await axios.post(VI_API_URL, soapBody, {
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': 'http://tempuri.org/SendSMSWithDLR'
            },
            responseType: 'text',
            validateStatus: () => true,   // SOAP faults arrive as HTTP 500 — inspect, don't throw
        });

        const xml  = String(viResponse.data || '');
        const code = Number(xmlTag(xml, 'responseCode'));
        const msg  = xmlTag(xml, 'responseMessage') || xmlTag(xml, 'faultstring') || '';
        const uuid = xmlTag(xml, 'Uuid') || '';
        console.log(`VI API HTTP ${viResponse.status}: responseCode=${code} responseMessage="${msg}" uuid=${uuid}`);

        if (viResponse.status !== 200 || code !== VI_SUCCESS_CODE) {
            // The verdict is in responseCode, not the HTTP status. Tell 3CX so
            // the message shows as failed instead of sent.
            console.error('VI did not accept the message:', xml.slice(0, 1000));
            return res.status(502).send(`VI rejected message: ${code || viResponse.status} ${msg}`);
        }

        // 3CX marks the message "sent" on any 2xx with a non-empty body.
        res.status(200).json({ ok: true, uuid });

    } catch (error) {
        console.error('Error sending via VI SOAP API:', error.message);
        res.status(503).send('Failed to reach VI SMS API');
    }
});

/**
 * 3. DLR CALLBACK: VoIP Innovations -> here
 * Dedicated URL for delivery receipts if you'd rather not share /inbound.
 */
app.post('/dlr', requireSecret, handleDlr);

// Health check
app.get('/', (req, res) => res.send('3CX-Sangoma SMS Middleware is running.'));

app.listen(PORT, () => {
    console.log(`Middleware listening on port ${PORT}`);
    console.log(`Inbound:  POST /inbound   (VI DID destination -> 3CX; status events accepted too)`);
    console.log(`Outbound: POST /outbound  (3CX -> VI SendSMSWithDLR)`);
    console.log(`DLR:      POST /dlr       (VI delivery receipts)`);
    if (!WEBHOOK_SECRET) {
        console.warn('WARNING: WEBHOOK_SECRET not set — webhook routes accept unauthenticated requests');
    }
    if (OUTBOUND_URL) {
        const q = WEBHOOK_SECRET ? '?secret=<WEBHOOK_SECRET>' : '';
        console.log(`VI DID destination (API POST): ${OUTBOUND_URL}/inbound${q}`);
        console.log(`3CX provider URL:              ${OUTBOUND_URL}/outbound  (+ X-Auth-Token header)`);
    }
});
