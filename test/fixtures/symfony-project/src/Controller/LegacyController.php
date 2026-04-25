<?php

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;

/**
 * Legacy controller using Doctrine annotation routing.
 */
class LegacyController extends AbstractController
{
    /**
     * Show the legacy index page.
     *
     * @Route("/legacy/", name="legacy_index", methods={"GET"})
     */
    public function index(): Response
    {
        return new Response('Legacy index');
    }

    /**
     * Create a legacy resource.
     *
     * @Route("/legacy/create", name="legacy_create", methods={"POST"})
     */
    public function create(): Response
    {
        return new Response('Created', 201);
    }

    /**
     * A route accepting multiple methods.
     *
     * @Route("/legacy/multi", name="legacy_multi", methods={"GET", "POST"})
     */
    public function multi(): Response
    {
        return new Response('Multi');
    }
}
