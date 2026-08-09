# Assistents

Assitents is a system that assists me in my life, in many areas:

* Dealing with invoices, for example doctor's invoices
* Dealing with insurances, for ex. claim my doctor's invoices
* Assist me with our house renovation: Follow up on processes (for ex. ask for construction permissions and all the paperwork), keep track of our budget

[TOC]


Our system will have different categories of moving parts:

* **Assistent** is basically an agent. It consists of a bunch of prompts, skills / agents, triggers (i.e. when does an assistent wake up to do something). 
* **Things** are the things we and our assistents move around. A thing is of a type or a model. Examples could be people, places, invoices, processes (for ex. the process of getting the construction permit for our house).
*  **External System**(s) with which the assistents interact. The assistents can take ops on external systems, for example they can `getNewMails` from the external system **`Email`**, they can `sendMoney` via the external system **`bank`**.
* **`ThingStore`**, a special external system. Basically a smart storage with some DMS (Document Management System) functionality that our assistents can interact with.
* **UI** aka **`UserInterface`** is kind of an external system that allows the agents to interact with the user. It offers the assistents ops like `showThingToUser` or `askUser`.


## Random thoughts

* **External Systems** have interfaces that send / receive things. Every object our assistents world emits or receives is a thing that has a model.
* **External Systems** can have a **Connector** that translates our things to/from external representations.
* **Assistents** can also talk to one another using thing's references, **ThingIDs**. The ThingID reveals the type of the thing (i.e. what model does it conform) and identifies it.
* How are the assistents waken up? 
* Do we need a thing of type **Conversation**? Or how / where do we keep track of such a thing like a thoughts process or a discussion?

## Assistents

Some of the assistents we will probably have:

* **Receptionist** is an egent that interacts with the outer world. He is the only one that accepts objects that are not things, as translating them to things is one of his duties. For example he accepts a PDF and makes it a proper *invoice thing* and stores it in our ThingStore and/or triggers an assistent.
* **Accountant** is an assistent that does what accountants typically do:
  * check invoices
  * pay invoices
  * add payments to different budget trackings
  * write invoices / claim money

### Assistent's life cycles

Assistent's are born when ther **trigger** fires. The trigger is an event together with an **input**. Typically this input gets replaced in the assistent's **initial prompt**, and with this the assistent starts living & running. Examples of an input could be a `thingID` or some text / prompt provided by anotrher assistent or by a user.
The assistent's birth initializes a conversation with the initial prompt. It's sent to the LLM, the answer comes back and the assistent does one of 2 things:
- Calls tools if toll-calls are wrapped in the LLM's answer
- Returns the answer to it's caller (human or other assistent)
This is what we call the **agentic loop**.

### Tech notes

* The assistent's conversation are obviously also things, thus have a model and a thingID.
* For the conversation and the **agentic loop** we should look at how the following trools do it:
* Opencode: https://github.com/anomalyco/opencode
* Pi: https://github.com/earendil-works/pi

## Things

Things can be anything I need my assistents to work on. There might be some thing types that are standard, and often times are maintained in standard external systems.

* **Person** is a thing type we might have and that is typically maintained in our address book.
* **Process** is a thing like a Routing Slip: Imaginge a sheet on which is logged what has been done alraedy and what still needs to be done. Can be a standard workflow (for ex. how do I process a doctor's invoice) or a more ad-hoc workflow (for ex. what is happening in order to get my construction permit).
* **Invoice**
* **Payment**

### Tech notes

* Things are A12 documents. They have A12 models.

## ThingStore

### Tech Notes

* The ThingStore is an A12 Data Service
* It provides the A12 JSON RPC interface with all of it's mightiness

## UserInterface

The UI is an A12 Web Application. It offers operstaions to the assistents like `openForUser(thingID)` or `askUser(thingID)` (that would ask the user a question with a definition of the answer's shape, i.e. yes/no, number, enum and maybe show one or more related things the user needs to take it's decision).

## External Systems

* Bank
* Accounting — concepts, required operations and market overview in [ACCOUNTING.md](ACCOUNTING.md)
* Email 
* ...


