import { mutation } from "../_generated/server";

export default mutation({
  handler: async (ctx) => {
    const techLeadJobId = "m17dhspq4653q094kwet2nng4d8a31e7" as any;
    const procurementJobId = "m170pg8bem9h6g60rdva2385hh8a2jdz" as any;

    const techLeadJd = `POSITION: Tech Lead – Frontend (React.js / Vue.js)

LOCATION: Sri Lanka / India (Remote / Hybrid)

Employment Type: Full-Time

Working Hours: 3:00 PM – 12:00 AM (SL/IST)

Compensation: USD 1,800 – 2,300 per month (based on experience and expertise)

About the Company
Our client is a fast-growing global technology organization delivering innovative software solutions for international markets. The company embraces modern engineering practices, AI-assisted development, and cloud technologies to build scalable, secure, and high-performing digital products.

As part of its continued growth, the organization is looking for an experienced Tech Lead – Frontend to lead the development of modern web applications, mentor engineering teams, and drive front-end excellence across multiple projects.

The Role
As the Tech Lead – Frontend, you will provide technical leadership while remaining hands-on in the development of enterprise-grade web applications. Working closely with Product, Design, Backend Engineering, and QA teams, you will be responsible for delivering intuitive, responsive, and scalable user interfaces using modern JavaScript frameworks.
You will also leverage AI-assisted development tools and agentic frameworks to improve engineering productivity while ensuring that all code meets high standards of quality, security, and maintainability.

Key Responsibilities
Design, develop, and maintain responsive web applications using React.js and/or Vue.js.
Convert UI/UX designs into reusable, high-quality front-end components.
Build reusable component libraries and scalable front-end architectures.
Integrate front-end applications with RESTful APIs and backend services.
Ensure applications are responsive, accessible, and compatible across modern browsers and devices.
Optimize front-end performance, scalability, and usability.
Collaborate closely with Backend Developers, UI/UX Designers, QA Engineers, Product Owners, and other stakeholders.
Maintain clean, readable, reusable, and well-documented code.
Troubleshoot and resolve front-end issues and production defects.
Enforce front-end development standards, secure coding practices, and engineering best practices.
Utilize AI-assisted development tools for code generation, refactoring, documentation, testing, and debugging.
Review, validate, and refine AI-generated code to ensure it aligns with architectural standards, security requirements, and long-term maintainability.
Mentor junior developers and provide technical guidance to the frontend engineering team.

Required Qualifications
Bachelor's Degree in Computer Science, Information Technology, Software Engineering, Engineering, or a related discipline.
Minimum 7 years of professional software development experience.
Proven experience leading or mentoring front-end development teams.
Strong expertise in React.js and/or Vue.js.
Excellent knowledge of: JavaScript (ES6+), HTML5, CSS3, Responsive Web Design
Experience integrating REST APIs into frontend applications.
Strong understanding of component-based front-end architecture.
Hands-on experience with state management libraries such as: Redux, Context API, Vuex, Pinia
Experience using modern front-end build tools including: Vite, Webpack, npm, Yarn
Ability to write clean, scalable, reusable, and maintainable code.

AI-Assisted Development Experience
The ideal candidate should have practical experience using AI-powered development tools and modern engineering workflows, including:
AI coding assistants, Agentic development frameworks, Code generation and refactoring, Automated documentation, Test case generation, AI-assisted debugging and issue resolution
Candidates should also demonstrate the ability to critically evaluate AI-generated code, ensuring:
Accuracy, Security, Performance, Maintainability, Compliance with coding standards

Leadership Expectations
Lead and mentor frontend developers.
Drive engineering best practices and coding standards.
Participate in architecture and technical design discussions.
Collaborate effectively with cross-functional teams.
Support continuous improvement initiatives and knowledge sharing.
Contribute to technical decision-making and project planning.

Preferred Skills
Experience with any of the following would be an added advantage:
TypeScript, Next.js, Nuxt.js, Tailwind CSS, Material UI, Storybook, GraphQL, Micro Frontend Architecture, Jest / Vitest, Cypress / Playwright, Docker, CI/CD pipelines, AWS, Azure, or Google Cloud, Agile/Scrum methodologies

Requirements added by the job poster
• 5+ years of work experience with React.js`;

    const procurementJd = `Position: Manager / AM – Group Procurement

Location: Colombo

Industry: Hospitality

Salary: Open to discuss 

About the Company
Our client is a leading premium 5-star hospitality group with a strong and expanding portfolio of luxury hotels and resorts. Renowned for delivering exceptional guest experiences and operational excellence, the group is focused on strengthening its centralized procurement function to drive cost efficiencies, supplier partnerships, and standardized procurement practices across all properties.

Role Overview
We are seeking an experienced Manager / Senior Manager – Group Procurement to lead the organization's centralized procurement function across multiple hotel properties.
This role will be responsible for developing and executing the Group procurement strategy, optimizing procurement operations, managing strategic supplier relationships, and driving sustainable cost savings while maintaining the highest standards of quality and guest experience.
The successful candidate will work closely with General Managers, Finance, Operations, Engineering, Culinary, and Property Procurement teams to ensure procurement supports both operational excellence and business profitability.

Key Responsibilities
Strategic Procurement Leadership
Develop and execute a centralized procurement strategy across all hotel properties.
Drive group-wide sourcing initiatives to optimize cost, quality, and supplier performance.
Establish procurement policies, governance frameworks, and standard operating procedures (SOPs).
Develop category strategies across: Identify opportunities for value engineering and continuous process improvement.

Supplier & Vendor Management
Identify, evaluate, onboard, and manage strategic suppliers across local and international markets.
Lead commercial negotiations, contract management, pricing agreements, and service level agreements (SLAs).
Build long-term partnerships with key suppliers to ensure continuity of supply.
Monitor supplier performance through KPIs, quality standards, and service delivery metrics.
Ensure supplier compliance with company policies and regulatory requirements.

Procurement Operations
Oversee procurement activities across multiple hotel properties.
Standardize purchasing practices and inventory management processes across the Group.
Collaborate closely with Executive Chefs, F&B teams, Housekeeping, Engineering, and Operations to ensure timely procurement of high-quality products.
Balance operational requirements with commercial objectives while maintaining brand standards.

Financial & Cost Management
Lead cost optimization and strategic sourcing initiatives across all procurement categories.
Monitor procurement spend, budgets, savings initiatives, and cost variances.
Conduct spend analysis and benchmarking to identify improvement opportunities.
Partner with Finance on forecasting, budgeting, cash flow planning, and working capital optimization.
Deliver measurable procurement savings while maintaining service quality.

Technology & Digital Procurement
Drive the implementation and optimization of ERP and e-procurement systems.
Improve procurement reporting through dashboards and spend analytics.
Promote digital procurement practices and automation initiatives.
Ensure procurement decisions are supported by accurate data and reporting.

Governance, Compliance & Risk Management
Ensure procurement activities comply with internal policies, audit requirements, and applicable regulations.
Maintain strong procurement governance and internal controls.
Lead procurement audits and implement corrective actions where required.
Identify procurement risks and implement mitigation strategies.

Leadership & Stakeholder Management
Lead and develop the Group Procurement function.
Provide guidance and support to property-level procurement teams.
Foster strong collaboration with General Managers, Finance, Operations, Culinary, Engineering, and other key stakeholders.
Develop a culture of accountability, continuous improvement, and high performance.

PRE-REQUISITES
Qualifications
Bachelor's degree in supply chain management, Procurement, Business Administration, Hospitality Management, or a related discipline.
Professional qualifications such as CIPS or equivalent will be a distinct advantage.

Experience
Minimum 4-6 years of progressive procurement experience.
Mandatory experience within 4-star or 5-star hotel chains.
Proven experience managing procurement across multiple properties or cluster operations.
Strong exposure to centralized or Group procurement environments.
Demonstrated success in supplier negotiations, procurement transformation, and cost optimization initiatives.

Requirements added by the job poster
• 5+ years of experience in Supply Chain`;

    await ctx.db.patch(techLeadJobId, { jobDescription: techLeadJd });
    await ctx.db.patch(procurementJobId, { jobDescription: procurementJd });

    return "Successfully updated JDs for Tech Lead and Group Procurement.";
  }
});
