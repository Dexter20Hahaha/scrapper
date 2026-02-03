const puppeteer = require('puppeteer');
const fs = require('fs');
require('dotenv').config();

(async () => {
    // 1. Launch the browser
    const browser = await puppeteer.launch({
        headless: "new", // Use the new headless mode
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // Helper to check if logged in
    const ensureLoggedIn = async () => {
        if (page.url().includes('login.php')) {
            console.log('Session expired or not logged in. Logging in...');
            await page.type('input[name="user"]', process.env.SYSTEM_LOGIN);
            await page.type('input[name="pass"]', process.env.SYSTEM_PASS);
            await Promise.all([
                page.click('input.orangebutton'),
                page.waitForNavigation({ waitUntil: 'networkidle2' }),
            ]);
            console.log('Logged in again.');
        }
    };

    try {
        console.log('Navigating to login page...');
        await page.goto(process.env.LOGIN_URL, { waitUntil: 'networkidle2' });

        // 2. Log in
        console.log('Logging in...');
        await page.type('input[name="user"]', process.env.SYSTEM_LOGIN);
        await page.type('input[name="pass"]', process.env.SYSTEM_PASS);

        // Click the submit button
        await Promise.all([
            page.click('input.orangebutton'),
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
        ]);

        console.log('Successfully logged in.');

        const allTickets = [];
        let currentPage = 1;
        let hasMorePages = true;

        // 3. Collect all ticket links across all pages
        console.log('Collecting all ticket links...');
        while (hasMorePages) {
            console.log(`Scanning page ${currentPage}...`);
            const pageUrl = `${process.env.LOGIN_URL}show_tickets.php?s0=1&s1=1&s2=1&s4=1&s5=1&p0=1&p1=1&p2=1&p3=1&category=0&sort=status&asc=1&limit=40&archive=0&s_my=1&s_ot=1&s_un=1&cot=0&g=&page=${currentPage}`;
            await page.goto(pageUrl, { waitUntil: 'networkidle2' });

            // Check session
            if (page.url().includes('login.php')) {
                await ensureLoggedIn();
                await page.goto(pageUrl, { waitUntil: 'networkidle2' });
            }

            const pageTickets = await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('table.white tr')).slice(1); // skip header
                return rows.map(row => {
                    const cells = row.querySelectorAll('td');
                    const linkEl = row.querySelector('a[href^="admin_ticket.php?track="]');
                    if (!linkEl) return null;
                    return {
                        url: linkEl.href,
                        id: cells[1]?.innerText.trim(),
                        address: cells[3]?.innerText.trim()
                    };
                }).filter(t => t !== null);
            });

            if (pageTickets.length === 0) {
                hasMorePages = false;
            } else {
                // Check if these tickets have already been added (detect infinite loop/last page repeat)
                const newTicketIds = new Set(pageTickets.map(t => t.id));
                const isDuplicatePage = pageTickets.some(t => allTickets.some(at => at.id === t.id));

                if (isDuplicatePage) {
                    console.log(`Page ${currentPage} contains duplicates of previously found tickets. Stopping pagination.`);
                    hasMorePages = false;
                } else {
                    allTickets.push(...pageTickets);
                    console.log(`Found ${pageTickets.length} tickets on page ${currentPage}.`);
                    currentPage++;

                    // Safety check: increased limit
                    if (currentPage > 100) hasMorePages = false;
                }
            }
        }

        console.log(`Total tickets found: ${allTickets.length}.`);

        // Pre-scan existing files to avoid duplicates
        const existingFiles = fs.readdirSync('.');
        const existingIds = new Set();
        existingFiles.forEach(file => {
            // File format: Address_Date_ID.pdf
            // We'll try to match the ID at the end.
            if (file.endsWith('.pdf')) {
                // Remove extension
                const noExt = file.slice(0, -4);
                // The ID is the last part after the last underscore, 
                // BUT the date also has underscores.
                // However, the ID is separated by underscores in the construction:
                // `${cleanAddress}_${cleanDate}_${cleanId}.pdf`
                // Let's rely on checking if the filename *ends with* `_${cleanId}.pdf` inside the loop.
            }
        });

        // 4. Process each ticket
        for (let i = 0; i < allTickets.length; i++) {
            const ticket = allTickets[i];
            const cleanId = (ticket.id || 'NoID').replace(/[\\/:"*?<>|]/g, '_').trim();

            // CHECK IF EXISTS
            const alreadyExists = existingFiles.some(f => f.endsWith(`_${cleanId}.pdf`));

            if (alreadyExists) {
                console.log(`[${i + 1}/${allTickets.length}] Skipping ticket ${ticket.id} (already downloaded).`);
                continue;
            }

            try {
                // Ensure session is active before navigation
                if (page.url().includes('login.php')) {
                    await ensureLoggedIn();
                }

                console.log(`Processing ticket ${ticket.id} (${i + 1}/${allTickets.length})...`);

                await page.goto(ticket.url, { waitUntil: 'networkidle2', timeout: 60000 });

                // Double check if redirected to login
                if (page.url().includes('login.php')) {
                    await ensureLoggedIn();
                    await page.goto(ticket.url, { waitUntil: 'networkidle2', timeout: 60000 });
                }

                // Extract the creation date from details with specific regex
                const creationDate = await page.evaluate(() => {
                    const bodyText = document.body.innerText;
                    // Look for Utworzona: followed by YYYY-MM-DD HH:MM:SS
                    const match = bodyText.match(/Utworzona:\s*(\d{4}-\d{2}-\d{2}(\s\d{2}:\d{2}:\d{2})?)/);
                    if (match) return match[1];
                    return 'UnknownDate';
                });

                // Clean up naming elements for filename
                const cleanAddress = (ticket.address || 'NoAddr').replace(/[\\/:"*?<>|]/g, '_').substring(0, 50).trim();
                const cleanDate = creationDate.replace(/:/g, '-').replace(/\s+/g, '_').trim();

                const fileName = `${cleanAddress}_${cleanDate}_${cleanId}.pdf`;

                await page.pdf({
                    path: fileName,
                    format: 'A4',
                    printBackground: true,
                    margin: {
                        top: '20px',
                        right: '20px',
                        bottom: '20px',
                        left: '20px'
                    }
                });

                console.log(`Saved: ${fileName}`);
            } catch (err) {
                console.error(`Error processing ticket ${ticket.id}: ${err.message}`);
                // Continue to next ticket
            }
        }

        console.log('Full scraping completed.');

    } catch (error) {
        console.error('An error occurred:', error);
    } finally {
        await browser.close();
        console.log('Browser closed.');
    }
})();
