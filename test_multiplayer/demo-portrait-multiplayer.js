// Headful multiplayer demo for portrait-game — two browser WINDOWS side by side
// Opens in portrait mobile device emulation with DevTools
const puppeteer = require('puppeteer');

const URL = 'http://localhost:8888/portrait-game/';
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Helper: press a key briefly
async function tap(page, key) {
    await page.keyboard.down(key);
    await sleep(40);
    await page.keyboard.up(key);
}

// Portrait mobile device emulation (iPhone 14 Pro)
const mobileDevice = {
    viewport: {
        width: 430,
        height: 932,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        isLandscape: false,
    },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

(async () => {
    console.log('=== Tandemonium Portrait-Game Multiplayer Demo ===\n');

    // Launch TWO separate browser windows with DevTools open
    const captainBrowser = await puppeteer.launch({
        headless: false,
        devtools: true,
        args: [
            '--no-sandbox',
            '--window-size=550,1100',
            '--window-position=0,50',
        ],
        defaultViewport: null
    });

    const stokerBrowser = await puppeteer.launch({
        headless: false,
        devtools: true,
        args: [
            '--no-sandbox',
            '--window-size=550,1100',
            '--window-position=570,50',
        ],
        defaultViewport: null
    });

    try {
        // --- CAPTAIN WINDOW (left) ---
        console.log('Opening Captain window (left, portrait mobile)...');
        const captainPage = (await captainBrowser.pages())[0];
        captainPage.on('pageerror', err => console.log('  [Cap ERR]', err.message));
        await captainPage.emulate(mobileDevice);
        await captainPage.goto(URL, { waitUntil: 'networkidle0', timeout: 15000 });

        // RIDE TOGETHER -> START A RIDE
        await captainPage.click('#btn-together');
        await sleep(500);
        await captainPage.click('#btn-captain');

        // Wait for room code
        await captainPage.waitForFunction(
            () => document.getElementById('room-code-display').textContent !== '----',
            { timeout: 10000 }
        );
        const roomCode = await captainPage.$eval('#room-code-display', el => el.textContent);
        console.log('Room code:', roomCode);

        // Give PeerJS a moment to register the peer ID
        await sleep(1000);

        // --- STOKER WINDOW (right) ---
        console.log('Opening Stoker window (right, portrait mobile)...');
        const stokerPage = (await stokerBrowser.pages())[0];
        stokerPage.on('pageerror', err => console.log('  [Sto ERR]', err.message));
        await stokerPage.emulate(mobileDevice);
        await stokerPage.goto(URL, { waitUntil: 'networkidle0', timeout: 15000 });

        // RIDE TOGETHER -> JOIN A RIDE -> enter code -> JOIN
        await stokerPage.click('#btn-together');
        await sleep(500);
        await stokerPage.click('#btn-stoker');
        await sleep(500);
        await stokerPage.$eval('#room-code-input', (el, code) => { el.value = code; }, roomCode.replace('TNDM-', ''));
        await sleep(200);
        await stokerPage.click('#btn-join');

        // Wait for both to connect
        console.log('Connecting P2P...');
        await Promise.all([
            captainPage.waitForFunction(
                () => document.getElementById('lobby').style.display === 'none',
                { timeout: 20000 }
            ),
            stokerPage.waitForFunction(
                () => document.getElementById('lobby').style.display === 'none',
                { timeout: 20000 }
            )
        ]);

        const capTransport = await captainPage.evaluate(() =>
            window._game && window._game.net ? window._game.net.transport : 'unknown'
        );
        console.log('Connected via', capTransport + '!\n');
        await sleep(1500);

        // Stoker dismisses instructions
        await stokerPage.evaluate(() => document.getElementById('instructions').click());
        await sleep(300);

        // Captain clicks instructions to start
        console.log('Captain starts...');
        await captainPage.evaluate(() => document.getElementById('instructions').click());

        // Wait until state is 'playing'
        await captainPage.waitForFunction(
            () => window._game && window._game.state === 'playing',
            { timeout: 10000 }
        );
        await sleep(800);
        console.log('GO!\n');

        // --- OFFSET PEDALING ---
        console.log('--- Offset pedaling ---');
        const captainFeet = ['ArrowUp', 'ArrowDown'];
        const stokerFeet  = ['ArrowDown', 'ArrowUp'];
        let capIdx = 0, stokIdx = 0;
        for (let i = 0; i < 12; i++) {
            const isCaptain = i % 2 === 0;
            const who = isCaptain ? 'Captain' : 'Stoker ';
            const page = isCaptain ? captainPage : stokerPage;
            const key = isCaptain ? captainFeet[capIdx % 2] : stokerFeet[stokIdx % 2];
            if (isCaptain) capIdx++; else stokIdx++;
            await tap(page, key);
            await sleep(350);
            const spd = await captainPage.$eval('#speed-display', el => el.textContent);
            console.log('  ' + who + ' ' + (key === 'ArrowUp' ? 'UP  ' : 'DOWN') + ' -> ' + spd);
        }

        // --- LEAN TOGETHER ---
        console.log('\n--- Both lean RIGHT + offset pedaling ---');
        captainPage.keyboard.down('KeyD');
        stokerPage.keyboard.down('KeyD');
        for (let i = 0; i < 6; i++) {
            const isCaptain = i % 2 === 0;
            const page = isCaptain ? captainPage : stokerPage;
            const key = isCaptain ? captainFeet[capIdx % 2] : stokerFeet[stokIdx % 2];
            if (isCaptain) capIdx++; else stokIdx++;
            await tap(page, key);
            await sleep(250);
        }
        await captainPage.keyboard.up('KeyD');
        await stokerPage.keyboard.up('KeyD');
        console.log('  Bike turned right!');
        await sleep(500);

        // --- LEAN FIGHT ---
        console.log('\n--- Lean FIGHT: Captain <- Stoker -> ---');
        captainPage.keyboard.down('KeyA');
        stokerPage.keyboard.down('KeyD');
        for (let i = 0; i < 6; i++) {
            const isCaptain = i % 2 === 0;
            const page = isCaptain ? captainPage : stokerPage;
            const key = isCaptain ? captainFeet[capIdx % 2] : stokerFeet[stokIdx % 2];
            if (isCaptain) capIdx++; else stokIdx++;
            await tap(page, key);
            await sleep(250);
        }
        await captainPage.keyboard.up('KeyA');
        await stokerPage.keyboard.up('KeyD');
        console.log('  Cancel out!');
        await sleep(500);

        // --- FAST BURST ---
        console.log('\n--- Speed burst (offset pedaling) ---');
        for (let i = 0; i < 20; i++) {
            const isCaptain = i % 2 === 0;
            const page = isCaptain ? captainPage : stokerPage;
            const key = isCaptain ? captainFeet[capIdx % 2] : stokerFeet[stokIdx % 2];
            if (isCaptain) capIdx++; else stokIdx++;
            await tap(page, key);
            await sleep(180);
        }
        const spd = await captainPage.$eval('#speed-display', el => el.textContent);
        const dist = await captainPage.$eval('#distance-display', el => el.textContent);
        console.log('  ' + spd + ' | ' + dist);

        // Print connection info
        const ping = await captainPage.evaluate(() =>
            window._game && window._game.net ? Math.round(window._game.net.pingMs) : -1
        );
        const transport = await captainPage.evaluate(() =>
            window._game && window._game.net ? window._game.net.transport : 'none'
        );
        console.log('\n  Transport:', transport, '| Ping:', ping + 'ms');

        console.log('\n=== Demo complete! Both windows stay open. ===');
        console.log('Try playing yourself! Ctrl+C to close.\n');
        await new Promise(() => {});

    } catch (err) {
        console.error('\nError:', err.message);
        try {
            const capState = await (await captainBrowser.pages())[0].evaluate(() => ({
                gameState: window._game ? window._game.state : 'no _game',
                netConnected: window._game && window._game.net ? window._game.net.connected : false,
                transport: window._game && window._game.net ? window._game.net.transport : 'none',
            }));
            const stoState = await (await stokerBrowser.pages())[0].evaluate(() => ({
                gameState: window._game ? window._game.state : 'no _game',
                netConnected: window._game && window._game.net ? window._game.net.connected : false,
                transport: window._game && window._game.net ? window._game.net.transport : 'none',
            }));
            console.log('\nCaptain:', JSON.stringify(capState));
            console.log('Stoker:', JSON.stringify(stoState));
        } catch (e) {}
        console.log('\nWindows stay open. Ctrl+C to close.');
        await new Promise(() => {});
    }
})();
