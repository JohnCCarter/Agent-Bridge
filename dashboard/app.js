const eventLogEl = document.getElementById('event-log');
const contractListEl = document.getElementById('contract-list');
const lockListEl = document.getElementById('lock-list');
const messageListEl = document.getElementById('message-list');
const indicatorEl = document.getElementById('connection-indicator');
const statusEl = document.getElementById('connection-status');

const contracts = new Map();
const locks = new Map();
const messages = new Map();
const events = [];

const eventUrl = window.DASHBOARD_EVENT_URL || '/events';

function formatTime(ts) {
    try {
        return new Intl.DateTimeFormat('sv-SE', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }).format(new Date(ts));
    } catch (_) {
        return ts;
    }
}

function createListItem(content) {
    const li = document.createElement('li');
    li.className = 'list-item';
    if (typeof content === 'string') {
        li.textContent = content;
        return li;
    }
    li.append(...content);
    return li;
}

function renderBadge(text, variant = '') {
    const span = document.createElement('span');
    span.className = `badge ${variant}`.trim();
    span.textContent = text;
    return span;
}

function renderContracts() {
    contractListEl.innerHTML = '';
    if (contracts.size === 0) {
        contractListEl.append(createListItem('Inga aktiva kontrakt'));
        return;
    }
    const sorted = Array.from(contracts.values())
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    for (const contract of sorted) {
        const title = document.createElement('header');
        title.textContent = contract.title || contract.id;
        title.append(renderBadge(contract.status, badgeVariantForStatus(contract.status)));

        const meta = document.createElement('div');
        meta.className = 'muted';
        meta.textContent = `Ägare: ${contract.owner || 'okänd'} • Initiativtagare: ${contract.initiator || 'okänd'} • Uppdaterad ${formatTime(contract.updatedAt || contract.createdAt)}`;

        const secondary = document.createElement('div');
        secondary.className = 'key-values';
        if (Array.isArray(contract.tags)) {
            for (const tag of contract.tags) {
                const span = document.createElement('span');
                span.textContent = tag;
                secondary.append(span);
            }
        }

        contractListEl.append(createListItem([title, meta, secondary]));
    }
}

function renderLocks() {
    lockListEl.innerHTML = '';
    if (locks.size === 0) {
        lockListEl.append(createListItem('Inga aktiva lås'));
        return;
    }
    const sorted = Array.from(locks.values())
        .sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
    for (const lock of sorted) {
        const header = document.createElement('header');
        header.textContent = lock.resource;
        header.append(renderBadge(lock.holder || 'okänd'));

        const timing = document.createElement('div');
        timing.className = 'muted';
        timing.textContent = `Låst av ${lock.holder || 'okänd'} • Går ut ${formatTime(lock.expiresAt)}`;

        lockListEl.append(createListItem([header, timing]));
    }
}

function renderMessages() {
    messageListEl.innerHTML = '';
    if (messages.size === 0) {
        messageListEl.append(createListItem('Inga nya meddelanden'));
        return;
    }
    const sorted = Array.from(messages.values())
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 10);
    for (const message of sorted) {
        const header = document.createElement('header');
        header.textContent = message.recipient || 'Okänd mottagare';
        header.append(renderBadge(message.status || 'published', 'warning'));

        const meta = document.createElement('div');
        meta.className = 'muted';
        meta.textContent = `Publicerat ${formatTime(message.timestamp)} • Kontrakt: ${message.contractId || 'ingen'}`;

        const body = document.createElement('div');
        body.textContent = message.content ? truncate(message.content, 140) : '(utan innehåll)';

        messageListEl.append(createListItem([header, meta, body]));
    }
}

function renderEvents() {
    eventLogEl.innerHTML = '';
    const recent = events.slice(-50).reverse();
    for (const entry of recent) {
        const header = document.createElement('header');
        header.textContent = `${formatTime(entry.timestamp)} – ${entry.type}`;
        header.append(renderBadge(entry.actor || 'system', entry.actor ? '' : 'muted'));

        const payload = document.createElement('pre');
        payload.textContent = JSON.stringify(entry.data, null, 2);

        eventLogEl.append(createListItem([header, payload]));
    }
}

function badgeVariantForStatus(status) {
    if (!status) return '';
    const normalized = status.toLowerCase();
    if (normalized === 'completed' || normalized === 'done') return 'success';
    if (normalized === 'failed' || normalized === 'cancelled' || normalized === 'blocked') return 'danger';
    if (normalized === 'in_progress') return 'warning';
    return '';
}

function truncate(text, limit) {
    if (!text) return '';
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function processEvent(evt) {
    const { type, data, timestamp } = evt;
    events.push({
        type,
        timestamp: timestamp || new Date().toISOString(),
        actor: data?.actor,
        data
    });

    switch (type) {
        case 'contract.created':
        case 'contract.updated':
            if (data?.contract?.id) {
                contracts.set(data.contract.id, data.contract);
            }
            break;
        case 'contract.deleted':
            if (data?.contractId) {
                contracts.delete(data.contractId);
            }
            break;
        case 'lock.created':
        case 'lock.renewed':
            if (data?.lock?.resource) {
                locks.set(data.lock.resource, data.lock);
            }
            break;
        case 'lock.released':
        case 'lock.expired':
            if (data?.resource) {
                locks.delete(data.resource);
            }
            break;
        case 'message.published':
            if (data?.message) {
                messages.set(data.message.id, data.message);
            }
            break;
        case 'message.acknowledged':
            if (data?.messageId) {
                messages.delete(data.messageId);
            }
            break;
        default:
            break;
    }

    renderContracts();
    renderLocks();
    renderMessages();
    renderEvents();
}

function connect() {
    if (!window.EventSource) {
        statusEl.textContent = 'EventSource stöds inte i denna webbläsare';
        indicatorEl.classList.remove('online');
        return;
    }
    const source = new EventSource(eventUrl);

    source.onopen = () => {
        indicatorEl.classList.add('online');
        statusEl.textContent = 'Ansluten';
    };

    source.onerror = () => {
        indicatorEl.classList.remove('online');
        statusEl.textContent = 'Avbruten, försöker igen…';
    };

    source.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            processEvent(payload);
        } catch (error) {
            console.error('Kunde inte tolka event', error);
        }
    };
}

renderContracts();
renderLocks();
renderMessages();
renderEvents();
connect();

// expose for debugging
window.DashboardState = {
    contracts,
    locks,
    messages,
    events
};
