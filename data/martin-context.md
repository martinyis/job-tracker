# Martin's Complete Profile Context

> This file provides deep personal and professional context for AI assistants helping with job applications, interview prep, and outreach. It goes far beyond the resume to capture personality, stories, motivations, and behavioral examples.

---

## Who I Am

- **Age:** 22 years old
- **Location:** San Jose, California (living with parents)
- **Education:** Computer Science student, graduating May 2026. GPA: 3.5
- **Originally from:** Ukraine (spent first 16 years there)
- **Languages:** English, Ukrainian, Russian
- **Work authorization:** Yes, authorized to work in the US
- **Portfolio:** https://stanislavbabak.com
- **GitHub:** https://github.com/martinyis

---

## Personality & Interests

**How my friends describe me:** Very disciplined but also very kind and funny. I have a great sense of humor and make good jokes when I'm with people.

**Outside of work, my life consists of:**
- **Calisthenics & fitness** - I train regularly, eat healthy, and take it seriously
- **Sauna** - Especially love going with friends, just sitting and talking. It's one of my favorite things
- **Running & cycling** - Regular cardio alongside calisthenics
- **Soccer** - Big fan, I cheer for FC Barcelona
- **Formula 1** - Max Verstappen fan. Every race Sunday I wake up at whatever time just to watch F1. I never miss a race
- **Movies** - Love deep, thought-provoking thrillers with interesting plots and high ratings. Not into fantasy. Don't have much time for movies but really enjoy them when I can
- **Board games** - Love playing Catan, poker, and pretty much any board game with friends
- **Snowboarding** - Another thing I love doing for fun
- **Spending time with friends** - Most of our time together is board games, sauna, or just hanging out

**Fun facts:**
- I wake up at any hour on Sundays just to watch Formula 1 races - never missed one
- I'm a board game enthusiast, especially Catan and poker
- I originally come from Ukraine and speak three languages
- I do calisthenics (bodyweight training) - it takes real discipline and progression

---

## Why I Code

I don't love coding itself - especially now that AI tools can handle a lot of the implementation. What I truly love is **software engineering as a discipline**: the architecture, the abstract thinking, the problem-solving. I love thinking about how features orchestrate together, how systems work as a whole, and then seeing the results and the impact on people's lives.

**What drives me:** Building things that bring real impact to people's lives. Seeing something I designed actually work and help someone - that's the best feeling.

**What I'm best at:** Architecture and abstract thinking. I think in systems, not in lines of code. I love designing how everything connects and then watching it come alive.

---

## Career Goals & What I Want

**Honest truth:** Right now I need a paycheck so I can work on my own projects and startups in my free time. But beyond the immediate need:

- **Short-term:** Get a solid engineering role where I can learn, earn, and grow
- **Medium-term (2-3 years):** Move into a lead or management role - team lead, engineering manager, or product engineering manager. I want to be responsible for the architecture and direction of development, not just writing code
- **Long-term dream:** Run my own startup. I want to build my own thing, be in charge of operations, and have equity in what I'm building
- **If it's a startup:** I get genuinely excited because there's responsibility and the potential upside of equity. Startups match my energy - I love the pressure and the speed

**What matters to me in a job:**
- **The team** - I care most that the people I work with are good humans who communicate well. No hidden agendas, no politics. People who help each other and have good team dynamics
- **Flexibility** - I'm very flexible and adaptable. Fast-paced startup chaos? Fine. Structured and calm? Also fine. I genuinely don't have a strong preference, as long as the team is good
- **Growth opportunity** - I want to be somewhere I can grow into more responsibility, not stay stagnant

---

## Work Experience Stories

### Mudface / Nanu (Skincare AI Platform) - Solo Developer, Internship

**The backstory:** I applied to this company in spring and went through interviews, but they hired another developer instead. For a whole month that other developer worked there. Then the recruiter called me back - they were going to fire the other developer and hire me instead. I started in September.

**What I walked into:** The existing application was barely working. Functionally bad, architecturally bad - just very, very poor quality. I had to do a complete restructuring of the architecture, rebuild core features, and start adding all the new features the product needed.

**How work was structured:** I had a manager who would give me required tasks for the week, and I'd work through them one by one until the manager was satisfied. There was a lot of pressure and a lot of features to deliver, but it was cool.

**Scale achieved:** Over time, the platform grew to real usage - about 1,000+ report generations on the web platform, with actual users relying on the product.

**The feature I'm most proud of - OCR Product Scanner:**
This is the feature that stands out above everything else. I was tasked with building a feature where users could scan any skincare product with their phone camera and get back all the information about it - the product name, brand, ingredients, a link to buy it, the full description.

I was genuinely scared when I got this assignment. I had absolutely no clue how to build it. But here's what I did:
1. I researched OCR libraries and found `react-native-text-recognition` for on-device text extraction
2. I had to build a text normalization pipeline (lowercase, remove punctuation, collapse spaces) because OCR output is messy
3. I needed a database of products to match against - so I manually subscribed to a bunch of skincare brands, collected their product data, subscribed to ingredient databases, and built out a 1000+ product database with full ingredient breakdowns
4. I implemented fuzzy matching (FuzzyWuzzy algorithm) against this database because OCR text is never perfect
5. Added a Perplexity AI fallback for when fuzzy matching couldn't identify the product
6. Built the entire flow end-to-end: camera capture -> OCR -> text normalization -> fuzzy matching -> AI fallback -> product detail display

**How it felt:** After getting it all working, I could just pick up any skincare product, point my phone at it, and instantly see everything about it. That was the most satisfying moment in my entire development career. I went from being terrified of the task to having built something that actually worked and felt like magic.

**What this project taught me:**
- How to completely restructure an existing codebase that was in bad shape
- Working under pressure with weekly deliverables and a manager checking progress
- Building complex features end-to-end when you have no idea where to start
- Cross-platform development (React Native mobile + Next.js web + Django backend)
- Custom ML model integration for computer vision (wrinkle, acne, pigmentation analysis)

### TaskMind (B2B SaaS Platform) - Team Lead, Team of 4

**How it happened:** This was a team project with friends. I was the most experienced developer on the team, so they made me the team lead.

**My role as team lead:**
- Made all architecture decisions for both frontend and backend
- Assigned features and tasks to team members
- Reviewed all pull requests before merging
- Managed deployments (both frontend to Vercel and backend to Google Cloud App Engine)
- Made sure everything worked together and nothing broke
- Oversaw the overall system design: how the frontend communicates with the backend, database schema design, API structure

**It wasn't a super intense management role** - more of a technical lead. But I was responsible for the quality and architecture of everything that shipped.

**What I built:** Full-stack platform with AI-powered company research, contact discovery, email generation, interactive D3.js strategy builder, Stripe billing, team management. Deployed and running in production at taskmind.pro.

### Airfare (Flight Price Tracker) - Solo Developer

**Why I built it:** I was searching for flights with flexible dates - like "sometime in April, 10-14 nights" - and had to manually check dozens of date combinations on Google Flights. It was incredibly tedious. I realized AI tools could help me build a solution in about a week, so I just went for it.

**The strategic thinking:** Beyond solving my own problem, I saw it as a strong portfolio project AND a potential revenue opportunity. The plan: build it, launch on the App Store, market it on TikTok, and see if it can generate revenue.

**Current status:** Built in ~3 weeks. Currently preparing for App Store launch. I use it myself and it works.

**What makes it technically interesting:**
- Sentinel strategy for price monitoring that reduces API costs by ~90%
- Full Apple In-App Purchase integration with server-side receipt validation
- Token rotation with replay detection (production-grade security)
- Real credit economy with unit economics worked out (~50% margin per search)

### LinkedIn Job Tracker (This Project) - Solo Developer

**Why I built it:** I want to be the first person to apply to every good position. Instead of manually checking LinkedIn dozens of times a day, reading every job description, I built an autonomous agent that watches LinkedIn 24/7. As soon as it finds a good position, it sends me a Telegram notification so I can apply immediately.

**The result:** The system processes hundreds of jobs per day through a 6-layer filtering pipeline and a 16-dimension scoring engine. I'm always among the first to apply to the best positions.

---

## Behavioral Question Examples

### "Tell me about a time something went wrong"

During Mudface, I made changes to the backend locally that were meant for the mobile app, then pushed and deployed. Later, I made separate changes to the web platform's backend and deployed that too. The problem? The backend serves BOTH the mobile app and the web platform. My web deploy overwrote the mobile-compatible backend and introduced a bunch of errors for mobile app users.

**What I did (in order):**
1. **First priority: stop the bleeding.** I immediately redeployed the previous working backend version to restore service for mobile users
2. **Then I fixed it properly:** Went to my local machine and carefully separated the web features from the mobile features in the backend code
3. **Deployed the cleaned-up version** that supported both platforms correctly
4. **Key learning:** With mobile apps, you can't just push backend changes freely because mobile apps go through App Store review and users update on their own timeline. The backend needs to stay backward-compatible with older app versions

### "What's your biggest weakness?"

My communication skills, specifically because English is my second language. My vocabulary isn't as strong as I'd like, I make grammatical mistakes when speaking, and I have patterns in my speech that I don't even notice. The biggest challenge is that I have so many thoughts and so much I want to say, but it's hard to structure it all in my head and deliver it as clean, organized speech.

**What I'm doing about it:** I'm actually building an app to fix this. It's an AI-powered speech coach where I talk to an AI agent for 30 minutes, then it identifies patterns and mistakes in my speech, shows which mistakes I make most often, and gives me exercises to fix them. I'm considering launching it on the App Store too.

### "What's your biggest strength (non-technical)?"

Discipline and perseverance. When I decide to build something, I don't stop until it's done. I built a full skincare AI platform solo, a flight tracker from scratch in 3 weeks, and an automated job hunting system - all while being a full-time student. I don't wait for someone to tell me what to learn or what to build. I see a problem, I design a solution, and I execute. My friends would say the same thing - I'm one of the most disciplined people they know.

### "Why do you want to work here?"

*(Note for AI: Tailor this based on the specific company. If it's a startup, lean into the excitement about impact and equity. If it's a larger company, focus on the team, growth, and the specific product. Always connect to something the company is actually building.)*

### "Tell me about a challenging project"

The OCR product scanner at Mudface. (See the full story above in the Mudface section.) Key points: I had no idea how to build it, I was genuinely scared, but I broke it down - researched OCR libraries, built a product database from scratch, implemented fuzzy matching, added AI fallback, and delivered a working feature that felt like magic.

### "Where do you see yourself in 5 years?"

I want to be in a leadership role - either running my own startup or leading an engineering team. I'm most passionate about the architecture and product direction side of development. I want to be the person making decisions about how systems are built, not just the person implementing them.

### "Tell me a fun fact about yourself"

I'm a huge Formula 1 fan - I wake up at whatever time necessary every race Sunday, even 4 AM, and I've never missed a single race. I also recently started building an AI app to improve my own English speaking skills, which might become my next App Store launch.

*(Alternative fun facts: I'm from Ukraine and speak three languages. I'm a board game enthusiast, especially Catan and poker nights with friends. I do calisthenics - bodyweight training that requires serious discipline and progressive overload.)*

---

## How I Learn New Technologies

My process when I need to build something I've never done before:
1. **Read the documentation** for relevant libraries and frameworks
2. **Watch tutorials** to see how others have approached similar problems
3. **Look for existing implementations** on GitHub, Reddit, Stack Overflow - find working examples I can study
4. **Just start coding and testing** - a LOT of trial and error. I run code constantly, try different approaches, test with different inputs
5. **Iterate rapidly** - if one library doesn't work, I find another. If one approach is too complex, I simplify

The key thing about my learning style: I'm not afraid to just start and figure it out. With the OCR scanner, I had zero experience with computer vision, text recognition, or fuzzy matching. I just started researching and testing until it worked.

*(Note: I now use AI coding tools extensively for implementation, but the architecture, system design, and problem-solving approach is all mine.)*

---

## Communication Style Notes for AI

When writing responses as me, keep these in mind:
- I'm direct and straightforward - no fluff or corporate speak
- I'm confident but not arrogant - I know what I've built but I don't oversell
- I use simple language, not fancy vocabulary
- I occasionally use casual phrasing - it's part of my personality
- I'm honest, sometimes bluntly so (I said I need a paycheck, not "I'm seeking a mission-aligned opportunity")
- I get genuinely excited when talking about architecture and system design
- I'm humble about my English but I don't let it hold me back
- I value team chemistry over everything else in a workplace
- I don't BS - if I don't know something, I'll say so

**Words/phrases I would NEVER say:**
- "Passionate about leveraging cutting-edge technologies"
- "Synergy", "paradigm shift", "thought leader"
- "I'm excited about the opportunity to..." (too corporate)
- Anything that sounds like it was generated by ChatGPT

**Words/phrases that sound like me:**
- "I built X from scratch"
- "I just went for it"
- "It was really cool to see it work"
- "I had no clue how to do it but I figured it out"
- "The architecture is what excites me"

---

## Products & Industries I Care About

I'm most interested in building **consumer-facing products** - apps and platforms used by regular people who aren't technically savvy. I want to make technology accessible.

I'm NOT particularly drawn to enterprise B2B tools, developer tools, or deep infrastructure (though I can build them - TaskMind is B2B).

If I could build anything, it would be in: **AI-powered consumer apps, health/wellness tech, travel tech, or tools that solve everyday problems for regular people.**

---

## Key Numbers to Reference

| Metric | Value |
|--------|-------|
| Projects built | 4 major full-stack applications |
| Team leadership | Led a team of 4 developers on TaskMind |
| Mudface users | 1,000+ report generations on web platform |
| Mudface product DB | 1,000+ skincare products catalogued |
| Airfare development | Built in ~3 weeks, solo |
| Job Tracker processing | Hundreds of jobs filtered per day |
| Languages spoken | 3 (English, Ukrainian, Russian) |
| Tech breadth | React Native, Next.js, Express, Django, PostgreSQL, MongoDB, SQLite, AWS, GCP |
