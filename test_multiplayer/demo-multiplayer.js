// Headful multiplayer demo — two browser WINDOWS side by side
// Opens in mobile device emulation (landscape) with DevTools
const puppeteer = require('puppeteer');

const URL = 'http://localhost:8888/';
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Helper: press a key briefly
async function tap(page, key) {
    await page.keyboard.down(key);
    await sleep(40);
    await page.keyboard.up(key);
}

// Mobile device to emulate (landscape iPhone-like)
const mobileDevice = {
    viewport: {
        width: 844,
        height: 390,
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        isLandscape: true,
    },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

(async () => {
    console.log('=== Tandemonium Multiplayer Demo (Mobile + DevTools) ===\n');

    // Launch TWO separate browser windows with DevTools open
    const captainBrowser = await puppeteer.launch({
        headless: false,
        devtools: true,
        args: [
            '--no-sandbox',
            '--window-size=1200,700',
            '--window-position=0,50',
        ],
        defaultViewport: null  // let emulate() control viewport
    });

    const stokerBrowser = await puppeteer.launch({
        headless: false,
        devtools: true,
        args: [
            '--no-sandbox',
            '--window-size=1200,700',
            '--window-position=820,50',
        ],
        defaultViewport: null  // let emulate() control viewport
    });

    try {
        // --- CAPTAIN WINDOW (left) ---
        console.log('Opening Captain window (left, mobile landscape)...');
        const captainPage = (await captainBrowser.pages())[0];
        captainPage.on('pageerror', err => console.log('  [Cap ERR]', err.message));
        await captainPage.emulate(mobileDevice);
        await captainPage.goto(URL, { waitUntil: 'networkidle0', timeout: 15000 });

        // RIDE TOGETHER → START A RIDE
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
        console.log('Opening Stoker window (right, mobile landscape)...');
        const stokerPage = (await stokerBrowser.pages())[0];
        stokerPage.on('pageerror', err => console.log('  [Sto ERR]', err.message));
        await stokerPage.emulate(mobileDevice);
        await stokerPage.goto(URL, { waitUntil: 'networkidle0', timeout: 15000 });

        // RIDE TOGETHER → JOIN A RIDE → enter code → JOIN
        await stokerPage.click('#btn-together');
        await sleep(500);
        await stokerPage.click('#btn-stoker');
        await sleep(500);
        await stokerPage.$eval('#room-code-input', (el, code) => { el.value = code; }, roomCode);
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
        console.log('Connected!\n');
        await sleep(1500);

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
        // Each player alternates their own feet (like solo), while maintaining
        // offset with the other player: Cap Up → Stok Down → Cap Down → Stok Up
        console.log('--- Offset pedaling ---');
        const captainFeet = ['ArrowUp', 'ArrowDown']; // alternates
        const stokerFeet  = ['ArrowDown', 'ArrowUp'];  // opposite offset
        let capIdx = 0, stokIdx = 0;
        for (let i = 0; i < 12; i++) {
            const isCaptain = i % 2 === 0;
            const who = isCaptain ? 'Captain' : 'Stoker ';
            const page = isCaptain ? captainPage : stokerPage;
            const key = isCaptain ? captainFeet[capIdx % 2] : stokerFeet[stokIdx % 2];
            if (isCaptain) capIdx++; else stokIdx++;
            await tap(page, key);
            await sleep(350);
            const spd = await captainPage.$eval('#speed', el => el.textContent);
            console.log('  ' + who + ' ' + (key === 'ArrowUp' ? 'UP  ' : 'DOWN') + ' → ' + spd);
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
        console.log('\n--- Lean FIGHT: Captain ← Stoker → ---');
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

        // --- FAST BURST (offset pedaling) ---
        console.log('\n--- Speed burst (offset pedaling) ---');
        for (let i = 0; i < 20; i++) {
            const isCaptain = i % 2 === 0;
            const page = isCaptain ? captainPage : stokerPage;
            const key = isCaptain ? captainFeet[capIdx % 2] : stokerFeet[stokIdx % 2];
            if (isCaptain) capIdx++; else stokIdx++;
            await tap(page, key);
            await sleep(180);
        }
        const spd = await captainPage.$eval('#speed', el => el.textContent);
        const dist = await captainPage.$eval('#distance', el => el.textContent);
        console.log('  ' + spd + ' | ' + dist);

        console.log('\n=== Demo complete! Both windows stay open. ===');
        console.log('Try playing yourself! Ctrl+C to close.\n');
        await new Promise(() => {});

    } catch (err) {
        console.error('\nError:', err.message);
        // Dump debug from both
        try {
            const capDbg = await (await captainBrowser.pages())[0].evaluate(() =>
                document.getElementById('debug-console').textContent
            );
            const stoDbg = await (await stokerBrowser.pages())[0].evaluate(() =>
                document.getElementById('debug-console').textContent
            );
            console.log('\nCaptain debug:', capDbg);
            console.log('Stoker debug:', stoDbg);
        } catch (e) {}
        console.log('\nWindows stay open. Ctrl+C to close.');
        await new Promise(() => {});
    }
})();
