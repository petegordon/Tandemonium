// Automated multiplayer test for portrait-game: two browser tabs, Captain + Stoker
const puppeteer = require('puppeteer');

const URL = 'http://localhost:8888/portrait-game/';
const TIMEOUT = 30000;

(async () => {
    console.log('=== Tandemonium Portrait-Game Multiplayer Test ===\n');

    const browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        defaultViewport: { width: 430, height: 932 }  // Portrait viewport (iPhone 14 Pro)
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
        await stokerPage.setViewport({ width: 430, height: 932 });
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

        // Wait for PeerJS signaling
        console.log('\n   Waiting for PeerJS signaling...');

        // Wait for connection on both sides (lobby disappears when connected)
        console.log('\n8. Waiting for connection...');

        const captainConnected = captainPage.waitForFunction(
            () => document.getElementById('lobby').style.display === 'none',
            { timeout: 20000 }
        ).then(() => {
            console.log('   Captain: Connected!');
            return true;
        }).catch(() => {
            console.log('   Captain: TIMEOUT waiting for connection');
            return false;
        });

        const stokerConnected = stokerPage.waitForFunction(
            () => document.getElementById('lobby').style.display === 'none',
            { timeout: 20000 }
        ).then(() => {
            console.log('   Stoker: Connected!');
            return true;
        }).catch(() => {
            console.log('   Stoker: TIMEOUT waiting for connection');
            return false;
        });

        const [capOk, stoOk] = await Promise.all([captainConnected, stokerConnected]);

        if (!capOk || !stoOk) {
            const hostStatus = await captainPage.$eval('#host-status', el => el.textContent).catch(() => 'N/A');
            const joinStatus = await stokerPage.$eval('#join-status', el => el.textContent).catch(() => 'N/A');
            console.log('\n   DEBUG - Host status:', hostStatus);
            console.log('   DEBUG - Join status:', joinStatus);

            // Check network transport
            const capTransport = await captainPage.evaluate(() =>
                window._game && window._game.net ? window._game.net.transport : 'no net'
            );
            const stoTransport = await stokerPage.evaluate(() =>
                window._game && window._game.net ? window._game.net.transport : 'no net'
            );
            console.log('   DEBUG - Captain transport:', capTransport);
            console.log('   DEBUG - Stoker transport:', stoTransport);

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

        // Check transport type
        const capTransport = await captainPage.evaluate(() =>
            window._game && window._game.net ? window._game.net.transport : 'unknown'
        );
        const stoTransport = await stokerPage.evaluate(() =>
            window._game && window._game.net ? window._game.net.transport : 'unknown'
        );
        console.log('   Captain transport:', capTransport);
        console.log('   Stoker transport:', stoTransport);

        // Check game state
        const capState = await captainPage.evaluate(() => window._game ? window._game.state : 'no ref');
        const stoState = await stokerPage.evaluate(() => window._game ? window._game.state : 'no ref');
        console.log('   Captain game state:', capState);
        console.log('   Stoker game state:', stoState);

        // Check instructions are visible (waiting for tap to start)
        const capInstHidden = await captainPage.$eval('#instructions', el => el.classList.contains('hidden'));
        const stoInstHidden = await stokerPage.$eval('#instructions', el => el.classList.contains('hidden'));
        console.log('   Captain instructions visible:', !capInstHidden);
        console.log('   Stoker instructions visible:', !stoInstHidden);

        // Stoker dismisses instructions first (just hides and waits)
        console.log('\n10. Stoker taps instructions (dismiss and wait)...');
        await stokerPage.evaluate(() => document.getElementById('instructions').click());
        await new Promise(r => setTimeout(r, 500));

        // Captain taps to start countdown
        console.log('11. Captain taps to start...');
        await captainPage.evaluate(() => document.getElementById('instructions').click());

        // Wait through 3s countdown + buffer
        console.log('    Waiting for countdown...');
        await captainPage.waitForFunction(
            () => window._game && window._game.state === 'playing',
            { timeout: 10000 }
        );
        console.log('    Captain is playing!');

        await stokerPage.waitForFunction(
            () => window._game && window._game.state === 'playing',
            { timeout: 10000 }
        );
        console.log('    Stoker is playing!');
        await new Promise(r => setTimeout(r, 500));

        // Test offset pedaling: Captain Up → Stoker Down → Captain Down → Stoker Up
        console.log('\n12. Testing offset pedaling...');
        const pedalSequence = [
            { page: captainPage, key: 'ArrowUp',   who: 'Captain', foot: 'UP  ' },
            { page: stokerPage,  key: 'ArrowDown',  who: 'Stoker ', foot: 'DOWN' },
            { page: captainPage, key: 'ArrowDown',  who: 'Captain', foot: 'DOWN' },
            { page: stokerPage,  key: 'ArrowUp',    who: 'Stoker ', foot: 'UP  ' },
        ];

        for (let cycle = 0; cycle < 3; cycle++) {
            for (const step of pedalSequence) {
                await step.page.keyboard.down(step.key);
                await new Promise(r => setTimeout(r, 40));
                await step.page.keyboard.up(step.key);
                await new Promise(r => setTimeout(r, 300));
            }
        }

        // Read speed
        const capSpeed = await captainPage.$eval('#speed-display', el => el.textContent);
        const capDist = await captainPage.$eval('#distance-display', el => el.textContent);
        console.log('    Captain:', capSpeed, '|', capDist);

        // Verify stoker also sees state updates
        const stoSpeed = await stokerPage.$eval('#speed-display', el => el.textContent);
        const stoDist = await stokerPage.$eval('#distance-display', el => el.textContent);
        console.log('    Stoker: ', stoSpeed, '|', stoDist);

        // Test leaning
        console.log('\n13. Testing lean (both lean right)...');
        await captainPage.keyboard.down('KeyD');
        await stokerPage.keyboard.down('KeyD');
        await new Promise(r => setTimeout(r, 1000));
        await captainPage.keyboard.up('KeyD');
        await stokerPage.keyboard.up('KeyD');

        const bikeLean = await captainPage.evaluate(() =>
            window._game ? window._game.bike.lean.toFixed(3) : 'N/A'
        );
        console.log('    Bike lean after right:', bikeLean);

        // Check connection is still alive
        const finalCapConnected = await captainPage.evaluate(() =>
            window._game && window._game.net ? window._game.net.connected : false
        );
        const finalStoConnected = await stokerPage.evaluate(() =>
            window._game && window._game.net ? window._game.net.connected : false
        );
        console.log('\n14. Connection still alive:');
        console.log('    Captain connected:', finalCapConnected);
        console.log('    Stoker connected:', finalStoConnected);

        // Ping
        const capPing = await captainPage.evaluate(() =>
            window._game && window._game.net ? Math.round(window._game.net.pingMs) : -1
        );
        console.log('    Ping:', capPing + 'ms');

        console.log('\n=== TEST COMPLETE ===');
        if (finalCapConnected && finalStoConnected) {
            console.log('Multiplayer connection: SUCCESS');
        } else {
            console.log('Multiplayer connection: FAILED (lost during gameplay)');
        }

        console.log('Keeping browser open for 5 seconds...\n');
        await new Promise(r => setTimeout(r, 5000));

    } catch (err) {
        console.error('\n*** TEST ERROR ***');
        console.error(err.message);

        // Dump diagnostics
        try {
            if (captainPage) {
                const capState = await captainPage.evaluate(() => ({
                    gameState: window._game ? window._game.state : 'no _game',
                    netConnected: window._game && window._game.net ? window._game.net.connected : false,
                    transport: window._game && window._game.net ? window._game.net.transport : 'none',
                }));
                console.log('\nCaptain diagnostics:', capState);
            }
            if (stokerPage) {
                const stoState = await stokerPage.evaluate(() => ({
                    gameState: window._game ? window._game.state : 'no _game',
                    netConnected: window._game && window._game.net ? window._game.net.connected : false,
                    transport: window._game && window._game.net ? window._game.net.transport : 'none',
                }));
                console.log('Stoker diagnostics:', stoState);
            }
        } catch (e) {}
    } finally {
        await browser.close();
    }
})();
