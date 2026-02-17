// Automated multiplayer test: two browser tabs, Captain + Stoker
const puppeteer = require('puppeteer');

const URL = 'http://localhost:8888/';
const TIMEOUT = 30000;

(async () => {
    console.log('=== Tandemonium Multiplayer Test ===\n');

    const browser = await puppeteer.launch({
        headless: false,  // visible so you can watch
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        defaultViewport: { width: 1024, height: 600 }
    });

    let captainPage, stokerPage;

    try {
        // --- TAB 1: Captain ---
        console.log('1. Opening Captain tab...');
        captainPage = await browser.newPage();
        captainPage.on('console', msg => {
            const t = msg.text();
            if (t.includes('NET:') || t.includes('error') || t.includes('Error') || t.includes('Peer'))
                console.log('  [Captain]', msg.type(), t);
        });
        captainPage.on('pageerror', err => console.log('  [Captain PAGE ERROR]', err.message));
        await captainPage.goto(URL, { waitUntil: 'networkidle0', timeout: TIMEOUT });
        console.log('   Page loaded.');

        // Click RIDE TOGETHER
        console.log('2. Captain clicks RIDE TOGETHER...');
        await captainPage.click('#btn-together');
        await captainPage.waitForSelector('#lobby-role', { visible: true, timeout: 5000 });
        console.log('   Role selection visible.');

        // Click START A RIDE (Captain)
        console.log('3. Captain clicks START A RIDE...');
        await captainPage.click('#btn-captain');
        await captainPage.waitForSelector('#lobby-host', { visible: true, timeout: 5000 });

        // Wait for room code to appear
        await captainPage.waitForFunction(
            () => document.getElementById('room-code-display').textContent !== '----',
            { timeout: 10000 }
        );
        const roomCode = await captainPage.$eval('#room-code-display', el => el.textContent);
        console.log('   Room created! Code:', roomCode);

        // --- TAB 2: Stoker ---
        console.log('\n4. Opening Stoker tab...');
        stokerPage = await browser.newPage();
        stokerPage.on('console', msg => {
            const t = msg.text();
            if (t.includes('NET:') || t.includes('error') || t.includes('Error') || t.includes('Peer'))
                console.log('  [Stoker]', msg.type(), t);
        });
        stokerPage.on('pageerror', err => console.log('  [Stoker PAGE ERROR]', err.message));
        await stokerPage.goto(URL, { waitUntil: 'networkidle0', timeout: TIMEOUT });
        console.log('   Page loaded.');

        // Click RIDE TOGETHER
        console.log('5. Stoker clicks RIDE TOGETHER...');
        await stokerPage.click('#btn-together');
        await stokerPage.waitForSelector('#lobby-role', { visible: true, timeout: 5000 });

        // Click JOIN A RIDE (Stoker)
        console.log('6. Stoker clicks JOIN A RIDE...');
        await stokerPage.click('#btn-stoker');
        await stokerPage.waitForSelector('#lobby-join', { visible: true, timeout: 5000 });

        // Type room code and join
        console.log('7. Stoker entering room code:', roomCode);
        await stokerPage.$eval('#room-code-input', (el, code) => { el.value = code; }, roomCode);
        await stokerPage.click('#btn-join');

        // Give PeerJS time to signal
        console.log('\n   Waiting 3s for PeerJS signaling...');
        await new Promise(r => setTimeout(r, 3000));

        // Dump dbg logs from both pages
        const capDbg = await captainPage.evaluate(() => {
            const el = document.getElementById('debug-console');
            return el ? el.textContent : 'no debug el';
        });
        const stoDbg = await stokerPage.evaluate(() => {
            const el = document.getElementById('debug-console');
            return el ? el.textContent : 'no debug el';
        });
        console.log('\n   --- Captain debug log ---');
        console.log(capDbg);
        console.log('\n   --- Stoker debug log ---');
        console.log(stoDbg);

        // Wait for connection on both sides
        console.log('\n8. Waiting for connection...');

        // Wait for lobby to disappear on captain (means connected + game started)
        const captainConnected = captainPage.waitForFunction(
            () => document.getElementById('lobby').style.display === 'none',
            { timeout: 15000 }
        ).then(() => {
            console.log('   Captain: Connected and game started!');
            return true;
        }).catch(() => {
            console.log('   Captain: TIMEOUT waiting for connection');
            return false;
        });

        const stokerConnected = stokerPage.waitForFunction(
            () => document.getElementById('lobby').style.display === 'none',
            { timeout: 15000 }
        ).then(() => {
            console.log('   Stoker: Connected and game started!');
            return true;
        }).catch(() => {
            console.log('   Stoker: TIMEOUT waiting for connection');
            return false;
        });

        const [capOk, stoOk] = await Promise.all([captainConnected, stokerConnected]);

        if (!capOk || !stoOk) {
            // Debug: check connection status text
            const hostStatus = await captainPage.$eval('#host-status', el => el.textContent).catch(() => 'N/A');
            const joinStatus = await stokerPage.$eval('#join-status', el => el.textContent).catch(() => 'N/A');
            console.log('\n   DEBUG - Host status:', hostStatus);
            console.log('   DEBUG - Join status:', joinStatus);
            console.log('\n*** CONNECTION FAILED ***');
            await browser.close();
            process.exit(1);
        }

        // Check connection badges
        console.log('\n9. Checking connection status...');
        const capConnBadge = await captainPage.$eval('#conn-badge', el => el.style.display).catch(() => 'hidden');
        const stoConnBadge = await stokerPage.$eval('#conn-badge', el => el.style.display).catch(() => 'hidden');
        console.log('   Captain conn badge visible:', capConnBadge === 'block');
        console.log('   Stoker conn badge visible:', stoConnBadge === 'block');

        // Check game state
        const capState = await captainPage.evaluate(() => window.__game ? window.__game.state : 'no ref');
        const stoState = await stokerPage.evaluate(() => window.__game ? window.__game.state : 'no ref');
        console.log('   Captain game state:', capState);
        console.log('   Stoker game state:', stoState);

        // Check instructions are visible (waiting for tap to start)
        const capInst = await captainPage.$eval('#instructions', el => el.style.display);
        const stoInst = await stokerPage.$eval('#instructions', el => el.style.display);
        console.log('   Captain instructions visible:', capInst !== 'none');
        console.log('   Stoker instructions visible:', stoInst !== 'none');

        // Try clicking to start on captain side
        console.log('\n10. Captain taps to start...');
        await captainPage.click('#instructions');
        await new Promise(r => setTimeout(r, 4500)); // wait through 3s countdown + buffer

        // Check if playing
        const capPlaying = await captainPage.$eval('#countdown-overlay', el => !el.classList.contains('active'));
        console.log('    Captain countdown finished:', capPlaying);

        // Test pedaling via spacebar on captain
        console.log('\n11. Testing pedal input...');
        await captainPage.keyboard.press('Space');
        await new Promise(r => setTimeout(r, 300));
        await stokerPage.keyboard.press('Space');
        await new Promise(r => setTimeout(r, 300));
        await captainPage.keyboard.press('Space');
        await new Promise(r => setTimeout(r, 300));

        // Read speed
        const capSpeed = await captainPage.$eval('#speed', el => el.textContent);
        console.log('    Captain speed after pedaling:', capSpeed);

        console.log('\n=== TEST COMPLETE ===');
        console.log('Multiplayer connection: SUCCESS');
        console.log('Keeping browser open for 5 seconds so you can see it...\n');
        await new Promise(r => setTimeout(r, 5000));

    } catch (err) {
        console.error('\n*** TEST ERROR ***');
        console.error(err.message);
    } finally {
        await browser.close();
    }
})();
